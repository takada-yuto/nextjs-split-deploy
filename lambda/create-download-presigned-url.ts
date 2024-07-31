import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Handler } from "aws-lambda"

const client = new S3Client({
  region: process.env.REGION,
})

const getPresignedUrl = async (
  bucket: string,
  key: string,
  expiresIn: number
): Promise<string> => {
  const objectParams = {
    Bucket: bucket,
    Key: key,
  }
  const signedUrl = await getSignedUrl(
    client,
    new GetObjectCommand(objectParams),
    { expiresIn }
  )
  console.log(signedUrl)
  return signedUrl
}

export const handler: Handler = async (event) => {
  const fileName = "env.prod.json"
  console.log(event)
  const { REGION, BUCKET, EXPIRES_IN } = process.env

  if (!REGION || !BUCKET || !EXPIRES_IN || isNaN(Number(EXPIRES_IN))) {
    throw new Error("invalid environment values")
  }

  const expiresIn = Number(EXPIRES_IN)
  const key = `env/${fileName}`
  console.log(BUCKET)
  console.log(expiresIn)
  console.log(key)

  const url = await getPresignedUrl(BUCKET, key, expiresIn)

  return {
    statusCode: 200,
    body: JSON.stringify({
      bucket: BUCKET,
      key: `https://${key}`,
      presignedUrl: url,
      fileName: fileName,
    }),
  }
}
