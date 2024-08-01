import * as cdk from "aws-cdk-lib"
import {
  AllowedMethods,
  CachedMethods,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  OriginAccessIdentity,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront"
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import { CanonicalUserPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam"
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import { RetentionDays } from "aws-cdk-lib/aws-logs"
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3"
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment"
import { Construct } from "constructs"
import { readFileSync } from "fs"

export class NextjsSplitDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // S3バケットの作成
    const nextjsStaticAssetsBucket = new Bucket(
      this,
      "NextjsStaticAssetsBucket",
      {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        cors: [
          {
            allowedHeaders: ["*"],
            allowedMethods: [cdk.aws_s3.HttpMethods.GET],
            allowedOrigins: ["*"],
          },
        ],
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      }
    )
    // const nextjsEnvBucket = new Bucket(this, "NextjsEnvBucket", {
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    //   autoDeleteObjects: true,
    //   cors: [
    //     {
    //       allowedHeaders: ["*"],
    //       allowedMethods: [cdk.aws_s3.HttpMethods.GET],
    //       allowedOrigins: ["*"],
    //     },
    //   ],
    // })

    // S3に静的ファイルをアップロード
    new BucketDeployment(this, "DeployNextjsStaticAssets", {
      sources: [Source.asset("./frontend/.next/static")],
      destinationBucket: nextjsStaticAssetsBucket,
      destinationKeyPrefix: "_next/static",
    })
    new BucketDeployment(this, "DeployNextjsPublicAssets", {
      sources: [Source.asset("./frontend/public")],
      destinationBucket: nextjsStaticAssetsBucket,
      destinationKeyPrefix: "public",
    })

    // Origin Access Identity (OAI) の作成
    const originAccessIdentity = new OriginAccessIdentity(this, "OAI", {
      comment: "OAI for NextjsStaticAssetsBucket",
    })

    // バケットポリシーの設定
    nextjsStaticAssetsBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${nextjsStaticAssetsBucket.bucketArn}/*`],
        principals: [
          new CanonicalUserPrincipal(
            originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    )

    // Lambdaの定義
    const nextjsImageFunction = new DockerImageFunction(
      this,
      "NextjsImageFunction",
      {
        code: DockerImageCode.fromImageAsset("./frontend", {
          platform: Platform.LINUX_AMD64,
        }),
        memorySize: 256,
        timeout: cdk.Duration.seconds(300),
        logRetention: RetentionDays.ONE_WEEK,
      }
    )

    // オブジェクトを書き込むLambda
    const iamRoleForLambda = new cdk.aws_iam.Role(this, "iamRoleForLambda", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    const createDownloadPresignedUrlFunction = new NodejsFunction(
      this,
      "CreateDownloadPresignedUrlFunction",
      {
        entry: "lambda/create-download-presigned-url.ts",
        handler: "handler",
        runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
        role: iamRoleForLambda,
        logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
        environment: {
          REGION: this.region,
          BUCKET: nextjsStaticAssetsBucket.bucketName,
          EXPIRES_IN: "3600",
        },
      }
    )

    const createDownloadPresignedUrlFunctionURL =
      createDownloadPresignedUrlFunction.addFunctionUrl({
        authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
      })
    nextjsStaticAssetsBucket.grantReadWrite(createDownloadPresignedUrlFunction)

    // ViewerRequestをはじく関数
    const viewerFunction = new cdk.aws_cloudfront.Function(
      this,
      "viewerFunction",
      {
        code: FunctionCode.fromInline(
          readFileSync("./lambda/viewer.js", "utf8")
        ),
        runtime: FunctionRuntime.JS_2_0,
        functionName: "viewerFunction",
      }
    )

    // CloudFrontの定義
    const distribution = new cdk.aws_cloudfront.Distribution(
      this,
      "nextjsSplitDeployDistribution",
      {
        comment: "nextjs-split-deploy-distribution",
        defaultBehavior: {
          origin: new cdk.aws_cloudfront_origins.FunctionUrlOrigin(
            nextjsImageFunction.addFunctionUrl({
              authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
            })
          ),
          viewerProtocolPolicy:
            cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy:
            cdk.aws_cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        },
        additionalBehaviors: {
          "/_next/static/*": {
            origin: new S3Origin(nextjsStaticAssetsBucket, {
              originAccessIdentity: new OriginAccessIdentity(
                this,
                "OriginAccessIdentityForStatic",
                {
                  comment: "Origin Access Identity for Static Files",
                }
              ),
            }),
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
            allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
            cachedMethods: CachedMethods.CACHE_GET_HEAD,
          },
          "/public/*": {
            origin: new S3Origin(nextjsStaticAssetsBucket, {
              originAccessIdentity: new OriginAccessIdentity(
                this,
                "OriginAccessIdentityForPublic",
                {
                  comment: "Origin Access Identity for Public Files",
                }
              ),
            }),
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
            allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
            cachedMethods: CachedMethods.CACHE_GET_HEAD,
          },
          "/env/*": {
            origin: new S3Origin(nextjsStaticAssetsBucket, {
              originAccessIdentity: originAccessIdentity,
            }),
            functionAssociations: [
              {
                eventType: FunctionEventType.VIEWER_REQUEST,
                function: viewerFunction,
              },
            ],
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
            allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
            cachedMethods: CachedMethods.CACHE_GET_HEAD,
          },
          "/create-presigned-url": {
            origin: new cdk.aws_cloudfront_origins.FunctionUrlOrigin(
              createDownloadPresignedUrlFunctionURL
            ),
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
            allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
            cachedMethods: CachedMethods.CACHE_GET_HEAD,
          },
        },
        enableLogging: true,
        httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2_AND_3,
        enableIpv6: false,
      }
    )

    // S3バケットへのOAIの設定
    const oai = new OriginAccessIdentity(this, "BucketOAI", {
      comment: "OAI for Next.js Static Assets Bucket",
    })

    // cloudfrontからのGETリクエストのみ許可
    nextjsStaticAssetsBucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${nextjsStaticAssetsBucket.bucketArn}/*`],
        principals: [
          new cdk.aws_iam.CanonicalUserPrincipal(
            oai.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    )

    // S3向けのCloudFront Distributionの定義
    const staticDistribution = new Distribution(this, "StaticDistribution", {
      defaultBehavior: {
        origin: new S3Origin(nextjsStaticAssetsBucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
    })

    // CloudFrontがLambda Function URLにアクセスする際の署名付きリクエスト作成
    const cfnOriginAccessControl =
      new cdk.aws_cloudfront.CfnOriginAccessControl(
        this,
        "OriginAccessControl",
        {
          originAccessControlConfig: {
            name: "Origin Access Control for Lambda Functions URL",
            originAccessControlOriginType: "lambda",
            signingBehavior: "always",
            signingProtocol: "sigv4",
          },
        }
      )

    const cfnDistribution = distribution.node
      .defaultChild as cdk.aws_cloudfront.CfnDistribution

    // 署名付きリクエストをcloudfrontに適用
    // フロントNextjs用
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId", // distributionで定義したoriginのindex
      cfnOriginAccessControl.attrId
    )
    // presigned url用
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.4.OriginAccessControlId",
      cfnOriginAccessControl.attrId
    )

    // Lambda Function URLsに特定のcloudfrontからのみのアクセスを許可
    nextjsImageFunction.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${
        cdk.Stack.of(this).account
      }:distribution/${distribution.distributionId}`,
    })
    // Lambda Function URLsに特定のcloudfrontからのみのアクセスを許可
    createDownloadPresignedUrlFunction.addPermission(
      "AllowCloudFrontdownloadUrlServicePrincipal",
      {
        principal: new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com"),
        action: "lambda:InvokeFunctionUrl",
        sourceArn: `arn:aws:cloudfront::${
          cdk.Stack.of(this).account
        }:distribution/${distribution.distributionId}`,
      }
    )
    new BucketDeployment(this, "DeployNextjsEnvJson", {
      sources: [
        Source.jsonData("env.json", {
          cloudfrontUrl: `https://${distribution.distributionDomainName}`,
          downloadS3Lambda: createDownloadPresignedUrlFunctionURL.url,
        }),
        Source.jsonData("env.prod.json", {
          bucketName: "こっちが本物のenv",
        }),
      ],
      destinationBucket: nextjsStaticAssetsBucket,
      destinationKeyPrefix: "env",
    })

    new cdk.CfnOutput(this, "DistributionDomain", {
      value: `https://${distribution.distributionDomainName}`,
    })
    new cdk.CfnOutput(this, "SaticDistributionDomain", {
      value: `https://${staticDistribution.distributionDomainName}`,
    })
  }
}
