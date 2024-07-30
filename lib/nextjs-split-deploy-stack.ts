import * as cdk from "aws-cdk-lib"
import {
  AllowedMethods,
  CachedMethods,
  Distribution,
  OriginAccessIdentity,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront"
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import { DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda"
import { RetentionDays } from "aws-cdk-lib/aws-logs"
import { Bucket } from "aws-cdk-lib/aws-s3"
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment"
import { Construct } from "constructs"
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class NextjsSplitDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // S3バケットの作成
    const bucket = new Bucket(this, "NextjsStaticAssetsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    // S3に静的ファイルをアップロード
    new BucketDeployment(this, "DeployNextjsStaticAssets", {
      sources: [Source.asset("./frontend/.next/static")],
      destinationBucket: bucket,
      destinationKeyPrefix: "_next/static",
    })
    new BucketDeployment(this, "DeployNextjsPublicAssets", {
      sources: [Source.asset("./frontend/public")],
      destinationBucket: bucket,
      destinationKeyPrefix: "public",
    })

    // Lambdaの定義
    const handler = new DockerImageFunction(this, "Handler", {
      code: DockerImageCode.fromImageAsset("./frontend", {
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(300),
      logRetention: RetentionDays.ONE_WEEK,
    })

    // CloudFrontの定義
    const distribution = new cdk.aws_cloudfront.Distribution(this, "Default", {
      defaultBehavior: {
        origin: new cdk.aws_cloudfront_origins.FunctionUrlOrigin(
          handler.addFunctionUrl({
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
          origin: new S3Origin(bucket, {
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
          origin: new S3Origin(bucket, {
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
      },
      enableLogging: true,
      httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: false,
    })

    // S3バケットへのOAIの設定
    const oai = new OriginAccessIdentity(this, "BucketOAI", {
      comment: "OAI for Next.js Static Assets Bucket",
    })

    bucket.grantRead(oai)

    // バケットポリシーの作成
    bucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${bucket.bucketArn}/*`],
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
        origin: new S3Origin(bucket, {
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
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      cfnOriginAccessControl.attrId
    )

    // Lambda Function URLsに特定のcloudfrontからのみのアクセスを許可
    handler.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new cdk.aws_iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${
        cdk.Stack.of(this).account
      }:distribution/${distribution.distributionId}`,
    })

    new cdk.CfnOutput(this, "DistributionDomain", {
      value: `https://${distribution.distributionDomainName}`,
    })
    new cdk.CfnOutput(this, "SaticDistributionDomain", {
      value: `https://${staticDistribution.distributionDomainName}`,
    })
  }
}
