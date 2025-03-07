import { randomUUID } from 'crypto';
import * as cxapi from '@aws-cdk/cx-api';
import * as cdk_assets from 'cdk-assets';
import * as chalk from 'chalk';
import { AssetManifestBuilder } from './asset-manifest-builder';
import {
  BasePublishProgressListener,
  PublishingAws,
} from './asset-publishing';
import { determineAllowCrossAccountAssetPublishing } from './checks';
import {
  CloudFormationStack,
  type ResourceIdentifierSummaries,
  ResourcesToImport,
  stabilizeStack,
  Template,
  uploadStackTemplateAssets,
} from './cloudformation';
import { deployStack, destroyStack } from './deploy-stack';
import { DeploymentMethod } from './deployment-method';
import { DeployStackResult } from './deployment-result';
import {
  loadCurrentTemplate,
  loadCurrentTemplateWithNestedStacks,
  type RootTemplateWithNestedStacks,
} from './nested-stack-helpers';
import { debug, warn } from '../../cli/messages';
import { IIoHost, IoMessaging } from '../../toolkit/cli-io-host';
import { ToolkitError } from '../../toolkit/error';
import { formatErrorMessage } from '../../util';
import type { SdkProvider } from '../aws-auth/sdk-provider';
import { type EnvironmentResources, EnvironmentAccess } from '../environment';
import { HotswapMode, HotswapPropertyOverrides } from '../hotswap/common';
import { StackActivityMonitor, StackEventPoller, RollbackChoice } from '../stack-events';
import type { Tag } from '../tags';
import { DEFAULT_TOOLKIT_STACK_NAME } from '../toolkit-info';
import { makeBodyParameter } from '../util/template-body-parameter';

const BOOTSTRAP_STACK_VERSION_FOR_ROLLBACK = 23;

export interface DeployStackOptions {
  /**
   * Stack to deploy
   */
  readonly stack: cxapi.CloudFormationStackArtifact;

  /**
   * Execution role for the deployment (pass through to CloudFormation)
   *
   * @default - Current role
   */
  readonly roleArn?: string;

  /**
   * Topic ARNs to send a message when deployment finishes (pass through to CloudFormation)
   *
   * @default - No notifications
   */
  readonly notificationArns?: string[];

  /**
   * Override name under which stack will be deployed
   *
   * @default - Use artifact default
   */
  readonly deployName?: string;

  /**
   * Name of the toolkit stack, if not the default name
   *
   * @default 'CDKToolkit'
   */
  readonly toolkitStackName?: string;

  /**
   * List of asset IDs which should NOT be built or uploaded
   *
   * @default - Build all assets
   */
  readonly reuseAssets?: string[];

  /**
   * Stack tags (pass through to CloudFormation)
   */
  readonly tags?: Tag[];

  /**
   * Stage the change set but don't execute it
   *
   * @default - true
   * @deprecated Use 'deploymentMethod' instead
   */
  readonly execute?: boolean;

  /**
   * Optional name to use for the CloudFormation change set.
   * If not provided, a name will be generated automatically.
   *
   * @deprecated Use 'deploymentMethod' instead
   */
  readonly changeSetName?: string;

  /**
   * Select the deployment method (direct or using a change set)
   *
   * @default - Change set with default options
   */
  readonly deploymentMethod?: DeploymentMethod;

  /**
   * Force deployment, even if the deployed template is identical to the one we are about to deploy.
   * @default false deployment will be skipped if the template is identical
   */
  readonly force?: boolean;

  /**
   * Extra parameters for CloudFormation
   * @default - no additional parameters will be passed to the template
   */
  readonly parameters?: { [name: string]: string | undefined };

  /**
   * Use previous values for unspecified parameters
   *
   * If not set, all parameters must be specified for every deployment.
   *
   * @default true
   */
  readonly usePreviousParameters?: boolean;

  /**
   * Rollback failed deployments
   *
   * @default true
   */
  readonly rollback?: boolean;

  /*
   * Whether to perform a 'hotswap' deployment.
   * A 'hotswap' deployment will attempt to short-circuit CloudFormation
   * and update the affected resources like Lambda functions directly.
   *
   * @default - `HotswapMode.FULL_DEPLOYMENT` for regular deployments, `HotswapMode.HOTSWAP_ONLY` for 'watch' deployments
   */
  readonly hotswap?: HotswapMode;

  /**
   * Properties that configure hotswap behavior
   */
  readonly hotswapPropertyOverrides?: HotswapPropertyOverrides;

  /**
   * The extra string to append to the User-Agent header when performing AWS SDK calls.
   *
   * @default - nothing extra is appended to the User-Agent header
   */
  readonly extraUserAgent?: string;

  /**
   * List of existing resources to be IMPORTED into the stack, instead of being CREATED
   */
  readonly resourcesToImport?: ResourcesToImport;

  /**
   * If present, use this given template instead of the stored one
   *
   * @default - Use the stored template
   */
  readonly overrideTemplate?: any;

  /**
   * Whether to build/publish assets in parallel
   *
   * @default true To remain backward compatible.
   */
  readonly assetParallelism?: boolean;

  /**
   * Whether to deploy if the app contains no stacks.
   *
   * @default false
   */
  ignoreNoStacks?: boolean;
}

export interface RollbackStackOptions {
  /**
   * Stack to roll back
   */
  readonly stack: cxapi.CloudFormationStackArtifact;

  /**
   * Execution role for the deployment (pass through to CloudFormation)
   *
   * @default - Current role
   */
  readonly roleArn?: string;

  /**
   * Don't show stack deployment events, just wait
   *
   * @default false
   */
  readonly quiet?: boolean;

  /**
   * Whether we are on a CI system
   *
   * @default false
   */
  readonly ci?: boolean;

  /**
   * Name of the toolkit stack, if not the default name
   *
   * @default 'CDKToolkit'
   */
  readonly toolkitStackName?: string;

  /**
   * Whether to force a rollback or not
   *
   * Forcing a rollback will orphan all undeletable resources.
   *
   * @default false
   */
  readonly force?: boolean;

  /**
   * Orphan the resources with the given logical IDs
   *
   * @default - No orphaning
   */
  readonly orphanLogicalIds?: string[];

  /**
   * Whether to validate the version of the bootstrap stack permissions
   *
   * @default true
   */
  readonly validateBootstrapStackVersion?: boolean;
}

export interface RollbackStackResult {
  readonly notInRollbackableState?: boolean;
  readonly success?: boolean;
}

interface AssetOptions {
  /**
   * Stack with assets to build.
   */
  readonly stack: cxapi.CloudFormationStackArtifact;

  /**
   * Execution role for the building.
   *
   * @default - Current role
   */
  readonly roleArn?: string;
}

export interface BuildStackAssetsOptions extends AssetOptions {
  /**
   * Stack name this asset is for
   */
  readonly stackName?: string;
}

interface PublishStackAssetsOptions extends AssetOptions {
  /**
   * Stack name this asset is for
   */
  readonly stackName?: string;

  /**
   * Always publish, even if it already exists
   *
   * @default false
   */
  readonly forcePublish?: boolean;
}

export interface DestroyStackOptions {
  stack: cxapi.CloudFormationStackArtifact;
  deployName?: string;
  roleArn?: string;
}

export interface StackExistsOptions {
  stack: cxapi.CloudFormationStackArtifact;
  deployName?: string;
  tryLookupRole?: boolean;
}

export interface DeploymentsProps {
  readonly sdkProvider: SdkProvider;
  readonly toolkitStackName?: string;
  readonly ioHost: IIoHost;
  readonly action: IoMessaging['action'];
}

/**
 * Scope for a single set of deployments from a set of Cloud Assembly Artifacts
 *
 * Manages lookup of SDKs, Bootstrap stacks, etc.
 */
export class Deployments {
  public readonly envs: EnvironmentAccess;

  /**
   * SDK provider for asset publishing (do not use for anything else).
   *
   * This SDK provider is only allowed to be used for that purpose, nothing else.
   *
   * It's not a different object, but the field name should imply that this
   * object should not be used directly, except to pass to asset handling routines.
   */
  private readonly assetSdkProvider: SdkProvider;

  /**
   * SDK provider for passing to deployStack
   *
   * This SDK provider is only allowed to be used for that purpose, nothing else.
   *
   * It's not a different object, but the field name should imply that this
   * object should not be used directly, except to pass to `deployStack`.
   */
  private readonly deployStackSdkProvider: SdkProvider;

  private readonly publisherCache = new Map<cdk_assets.AssetManifest, cdk_assets.AssetPublishing>();

  private _allowCrossAccountAssetPublishing: boolean | undefined;

  private readonly ioHost: IIoHost;
  private readonly action: IoMessaging['action'];

  constructor(private readonly props: DeploymentsProps) {
    this.assetSdkProvider = props.sdkProvider;
    this.deployStackSdkProvider = props.sdkProvider;
    this.ioHost = props.ioHost;
    this.action = props.action;
    this.envs = new EnvironmentAccess(
      props.sdkProvider,
      props.toolkitStackName ?? DEFAULT_TOOLKIT_STACK_NAME,
      { ioHost: this.ioHost, action: this.action },
    );
  }

  /**
   * Resolves the environment for a stack.
   */
  public async resolveEnvironment(stack: cxapi.CloudFormationStackArtifact): Promise<cxapi.Environment> {
    return this.envs.resolveStackEnvironment(stack);
  }

  public async readCurrentTemplateWithNestedStacks(
    rootStackArtifact: cxapi.CloudFormationStackArtifact,
    retrieveProcessedTemplate: boolean = false,
  ): Promise<RootTemplateWithNestedStacks> {
    const env = await this.envs.accessStackForLookupBestEffort(rootStackArtifact);
    return loadCurrentTemplateWithNestedStacks(rootStackArtifact, env.sdk, retrieveProcessedTemplate);
  }

  public async readCurrentTemplate(stackArtifact: cxapi.CloudFormationStackArtifact): Promise<Template> {
    await this.ioHost.notify(debug(this.action, `Reading existing template for stack ${stackArtifact.displayName}.`));
    const env = await this.envs.accessStackForLookupBestEffort(stackArtifact);
    return loadCurrentTemplate(stackArtifact, env.sdk);
  }

  public async resourceIdentifierSummaries(
    stackArtifact: cxapi.CloudFormationStackArtifact,
  ): Promise<ResourceIdentifierSummaries> {
    await this.ioHost.notify(debug(this.action, `Retrieving template summary for stack ${stackArtifact.displayName}.`));
    // Currently, needs to use `deploy-role` since it may need to read templates in the staging
    // bucket which have been encrypted with a KMS key (and lookup-role may not read encrypted things)
    const env = await this.envs.accessStackForReadOnlyStackOperations(stackArtifact);
    const cfn = env.sdk.cloudFormation();

    await uploadStackTemplateAssets(stackArtifact, this);

    // Upload the template, if necessary, before passing it to CFN
    const builder = new AssetManifestBuilder();
    const cfnParam = await makeBodyParameter(
      stackArtifact,
      env.resolvedEnvironment,
      builder,
      env.resources);

    // If the `makeBodyParameter` before this added assets, make sure to publish them before
    // calling the API.
    const addedAssets = builder.toManifest(stackArtifact.assembly.directory);
    for (const entry of addedAssets.entries) {
      await this.buildSingleAsset('no-version-validation', addedAssets, entry, {
        stack: stackArtifact,
      });
      await this.publishSingleAsset(addedAssets, entry, {
        stack: stackArtifact,
      });
    }

    const response = await cfn.getTemplateSummary(cfnParam);
    if (!response.ResourceIdentifierSummaries) {
      await this.ioHost.notify(debug(this.action, 'GetTemplateSummary API call did not return "ResourceIdentifierSummaries"'));
    }
    return response.ResourceIdentifierSummaries ?? [];
  }

  public async deployStack(options: DeployStackOptions): Promise<DeployStackResult> {
    let deploymentMethod = options.deploymentMethod;
    if (options.changeSetName || options.execute !== undefined) {
      if (deploymentMethod) {
        throw new ToolkitError(
          "You cannot supply both 'deploymentMethod' and 'changeSetName/execute'. Supply one or the other.",
        );
      }
      deploymentMethod = {
        method: 'change-set',
        changeSetName: options.changeSetName,
        execute: options.execute,
      };
    }

    const env = await this.envs.accessStackForMutableStackOperations(options.stack);

    // Do a verification of the bootstrap stack version
    await this.validateBootstrapStackVersion(
      options.stack.stackName,
      options.stack.requiresBootstrapStackVersion,
      options.stack.bootstrapStackVersionSsmParameter,
      env.resources);

    const executionRoleArn = await env.replacePlaceholders(options.roleArn ?? options.stack.cloudFormationExecutionRoleArn);

    return deployStack({
      stack: options.stack,
      resolvedEnvironment: env.resolvedEnvironment,
      deployName: options.deployName,
      notificationArns: options.notificationArns,
      sdk: env.sdk,
      sdkProvider: this.deployStackSdkProvider,
      roleArn: executionRoleArn,
      reuseAssets: options.reuseAssets,
      envResources: env.resources,
      tags: options.tags,
      deploymentMethod,
      force: options.force,
      parameters: options.parameters,
      usePreviousParameters: options.usePreviousParameters,
      rollback: options.rollback,
      hotswap: options.hotswap,
      hotswapPropertyOverrides: options.hotswapPropertyOverrides,
      extraUserAgent: options.extraUserAgent,
      resourcesToImport: options.resourcesToImport,
      overrideTemplate: options.overrideTemplate,
      assetParallelism: options.assetParallelism,
    }, { ioHost: this.ioHost, action: this.action });
  }

  public async rollbackStack(options: RollbackStackOptions): Promise<RollbackStackResult> {
    let resourcesToSkip: string[] = options.orphanLogicalIds ?? [];
    if (options.force && resourcesToSkip.length > 0) {
      throw new ToolkitError('Cannot combine --force with --orphan');
    }

    const env = await this.envs.accessStackForMutableStackOperations(options.stack);

    if (options.validateBootstrapStackVersion ?? true) {
      // Do a verification of the bootstrap stack version
      await this.validateBootstrapStackVersion(
        options.stack.stackName,
        BOOTSTRAP_STACK_VERSION_FOR_ROLLBACK,
        options.stack.bootstrapStackVersionSsmParameter,
        env.resources);
    }

    const cfn = env.sdk.cloudFormation();
    const deployName = options.stack.stackName;

    // We loop in case of `--force` and the stack ends up in `CONTINUE_UPDATE_ROLLBACK`.
    let maxLoops = 10;
    while (maxLoops--) {
      let cloudFormationStack = await CloudFormationStack.lookup(cfn, deployName);

      const executionRoleArn = await env.replacePlaceholders(options.roleArn ?? options.stack.cloudFormationExecutionRoleArn);

      switch (cloudFormationStack.stackStatus.rollbackChoice) {
        case RollbackChoice.NONE:
          await this.ioHost.notify(warn(this.action, `Stack ${deployName} does not need a rollback: ${cloudFormationStack.stackStatus}`));
          return { notInRollbackableState: true };

        case RollbackChoice.START_ROLLBACK:
          await this.ioHost.notify(debug(this.action, `Initiating rollback of stack ${deployName}`));
          await cfn.rollbackStack({
            StackName: deployName,
            RoleARN: executionRoleArn,
            ClientRequestToken: randomUUID(),
            // Enabling this is just the better overall default, the only reason it isn't the upstream default is backwards compatibility
            RetainExceptOnCreate: true,
          });
          break;

        case RollbackChoice.CONTINUE_UPDATE_ROLLBACK:
          if (options.force) {
            // Find the failed resources from the deployment and automatically skip them
            // (Using deployment log because we definitely have `DescribeStackEvents` permissions, and we might not have
            // `DescribeStackResources` permissions).
            const poller = new StackEventPoller(cfn, {
              stackName: deployName,
              stackStatuses: ['ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS'],
            });
            await poller.poll();
            resourcesToSkip = poller.resourceErrors
              .filter((r) => !r.isStackEvent && r.parentStackLogicalIds.length === 0)
              .map((r) => r.event.LogicalResourceId ?? '');
          }

          const skipDescription = resourcesToSkip.length > 0 ? ` (orphaning: ${resourcesToSkip.join(', ')})` : '';
          await this.ioHost.notify(warn(this.action, `Continuing rollback of stack ${deployName}${skipDescription}`));
          await cfn.continueUpdateRollback({
            StackName: deployName,
            ClientRequestToken: randomUUID(),
            RoleARN: executionRoleArn,
            ResourcesToSkip: resourcesToSkip,
          });
          break;

        case RollbackChoice.ROLLBACK_FAILED:
          await this.ioHost.notify(warn(
            this.action,
            `Stack ${deployName} failed creation and rollback. This state cannot be rolled back. You can recreate this stack by running 'cdk deploy'.`,
          ));
          return { notInRollbackableState: true };

        default:
          throw new ToolkitError(`Unexpected rollback choice: ${cloudFormationStack.stackStatus.rollbackChoice}`);
      }

      const monitor = new StackActivityMonitor({
        cfn,
        stack: options.stack,
        stackName: deployName,
        ioHost: this.ioHost,
        action: this.action,
      });
      await monitor.start();

      let stackErrorMessage: string | undefined = undefined;
      let finalStackState = cloudFormationStack;
      try {
        const successStack = await stabilizeStack(cfn, { ioHost: this.ioHost, action: this.action }, deployName);

        // This shouldn't really happen, but catch it anyway. You never know.
        if (!successStack) {
          throw new ToolkitError('Stack deploy failed (the stack disappeared while we were rolling it back)');
        }
        finalStackState = successStack;

        const errors = monitor.errors.join(', ');
        if (errors) {
          stackErrorMessage = errors;
        }
      } catch (e: any) {
        stackErrorMessage = suffixWithErrors(formatErrorMessage(e), monitor.errors);
      } finally {
        await monitor.stop();
      }

      if (finalStackState.stackStatus.isRollbackSuccess || !stackErrorMessage) {
        return { success: true };
      }

      // Either we need to ignore some resources to continue the rollback, or something went wrong
      if (finalStackState.stackStatus.rollbackChoice === RollbackChoice.CONTINUE_UPDATE_ROLLBACK && options.force) {
        // Do another loop-de-loop
        continue;
      }

      throw new ToolkitError(
        `${stackErrorMessage} (fix problem and retry, or orphan these resources using --orphan or --force)`,
      );
    }
    throw new ToolkitError(
      "Rollback did not finish after a large number of iterations; stopping because it looks like we're not making progress anymore. You can retry if rollback was progressing as expected.",
    );
  }

  public async destroyStack(options: DestroyStackOptions): Promise<void> {
    const env = await this.envs.accessStackForMutableStackOperations(options.stack);
    const executionRoleArn = await env.replacePlaceholders(options.roleArn ?? options.stack.cloudFormationExecutionRoleArn);

    return destroyStack({
      sdk: env.sdk,
      roleArn: executionRoleArn,
      stack: options.stack,
      deployName: options.deployName,
    }, { ioHost: this.ioHost, action: this.action });
  }

  public async stackExists(options: StackExistsOptions): Promise<boolean> {
    let env;
    if (options.tryLookupRole) {
      env = await this.envs.accessStackForLookupBestEffort(options.stack);
    } else {
      env = await this.envs.accessStackForReadOnlyStackOperations(options.stack);
    }
    const stack = await CloudFormationStack.lookup(env.sdk.cloudFormation(), options.deployName ?? options.stack.stackName);
    return stack.exists;
  }

  /**
   * Build a single asset from an asset manifest
   *
   * If an assert manifest artifact is given, the bootstrap stack version
   * will be validated according to the constraints in that manifest artifact.
   * If that is not necessary, `'no-version-validation'` can be passed.
   */
  // eslint-disable-next-line max-len
  public async buildSingleAsset(
    assetArtifact: cxapi.AssetManifestArtifact | 'no-version-validation',
    assetManifest: cdk_assets.AssetManifest,
    asset: cdk_assets.IManifestEntry,
    options: BuildStackAssetsOptions,
  ) {
    if (assetArtifact !== 'no-version-validation') {
      const env = await this.envs.accessStackForReadOnlyStackOperations(options.stack);
      await this.validateBootstrapStackVersion(
        options.stack.stackName,
        assetArtifact.requiresBootstrapStackVersion,
        assetArtifact.bootstrapStackVersionSsmParameter,
        env.resources);
    }

    const resolvedEnvironment = await this.envs.resolveStackEnvironment(options.stack);

    const publisher = this.cachedPublisher(assetManifest, resolvedEnvironment, options.stackName);
    await publisher.buildEntry(asset);
    if (publisher.hasFailures) {
      throw new ToolkitError(`Failed to build asset ${asset.displayName(false)}`);
    }
  }

  /**
   * Publish a single asset from an asset manifest
   */
  public async publishSingleAsset(
    assetManifest: cdk_assets.AssetManifest,
    asset: cdk_assets.IManifestEntry,
    options: PublishStackAssetsOptions,
  ) {
    const stackEnv = await this.envs.resolveStackEnvironment(options.stack);

    // No need to validate anymore, we already did that during build
    const publisher = this.cachedPublisher(assetManifest, stackEnv, options.stackName);
    await publisher.publishEntry(asset, {
      allowCrossAccount: await this.allowCrossAccountAssetPublishingForEnv(options.stack),
      force: options.forcePublish,
    });
    if (publisher.hasFailures) {
      throw new ToolkitError(`Failed to publish asset ${asset.displayName(true)}`);
    }
  }

  private async allowCrossAccountAssetPublishingForEnv(stack: cxapi.CloudFormationStackArtifact): Promise<boolean> {
    if (this._allowCrossAccountAssetPublishing === undefined) {
      const env = await this.envs.accessStackForReadOnlyStackOperations(stack);
      this._allowCrossAccountAssetPublishing = await determineAllowCrossAccountAssetPublishing(env.sdk, {
        ioHost: this.ioHost,
        action: this.action,
      }, this.props.toolkitStackName);
    }
    return this._allowCrossAccountAssetPublishing;
  }

  /**
   * Return whether a single asset has been published already
   */
  public async isSingleAssetPublished(
    assetManifest: cdk_assets.AssetManifest,
    asset: cdk_assets.IManifestEntry,
    options: PublishStackAssetsOptions,
  ) {
    const stackEnv = await this.envs.resolveStackEnvironment(options.stack);
    const publisher = this.cachedPublisher(assetManifest, stackEnv, options.stackName);
    return publisher.isEntryPublished(asset);
  }

  /**
   * Validate that the bootstrap stack has the right version for this stack
   *
   * Call into envResources.validateVersion, but prepend the stack name in case of failure.
   */
  private async validateBootstrapStackVersion(
    stackName: string,
    requiresBootstrapStackVersion: number | undefined,
    bootstrapStackVersionSsmParameter: string | undefined,
    envResources: EnvironmentResources,
  ) {
    try {
      await envResources.validateVersion(requiresBootstrapStackVersion, bootstrapStackVersionSsmParameter);
    } catch (e: any) {
      throw new ToolkitError(`${stackName}: ${formatErrorMessage(e)}`);
    }
  }

  private cachedPublisher(assetManifest: cdk_assets.AssetManifest, env: cxapi.Environment, stackName?: string) {
    const existing = this.publisherCache.get(assetManifest);
    if (existing) {
      return existing;
    }
    const prefix = stackName ? `${chalk.bold(stackName)}: ` : '';
    const publisher = new cdk_assets.AssetPublishing(assetManifest, {
      // The AssetPublishing class takes care of role assuming etc, so it's okay to
      // give it a direct `SdkProvider`.
      aws: new PublishingAws(this.assetSdkProvider, env),
      progressListener: new ParallelSafeAssetProgress(prefix, { ioHost: this.ioHost, action: this.action }),
    });
    this.publisherCache.set(assetManifest, publisher);
    return publisher;
  }
}

/**
 * Asset progress that doesn't do anything with percentages (currently)
 */
class ParallelSafeAssetProgress extends BasePublishProgressListener {
  private readonly prefix: string;

  constructor(prefix: string, { ioHost, action }: IoMessaging) {
    super({ ioHost, action });
    this.prefix = prefix;
  }

  protected getMessage(type: cdk_assets.EventType, event: cdk_assets.IPublishProgress): string {
    return `${this.prefix}${type}: ${event.message}`;
  }
}

function suffixWithErrors(msg: string, errors?: string[]) {
  return errors && errors.length > 0 ? `${msg}: ${errors.join(', ')}` : msg;
}
