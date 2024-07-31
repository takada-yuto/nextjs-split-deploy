import useSWR from "swr"

interface Env {
  bucketName: string | undefined
  bucketUrl: string
  downloadS3Lambda: string
}

const fetcher = async () => {
  const res = await fetch("/env/env.json")
  return res.json()
}
export default function useEnv() {
  const { data: env } = useSWR<Env>("/env/env.json", fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  })

  if (!env) {
    return {
      env: Object.freeze({
        bucketName: "not found",
      }) as Env,
    }
  }
  console.log(env)

  const downloadFile = async (url: string) => {
    const downloadResponse = await fetch("/create-presigned-url")
    if (!downloadResponse.ok) {
      throw new Error("Failed to fetch downloadResponse")
    }
    const data = await downloadResponse.json()
    console.log(data)
    const envUrl = data.presignedUrl
    const response = await fetch(`${envUrl}`)
    if (!response.ok) {
      throw new Error("Failed to fetch env.prod.json")
    }
    console.log(response)
    const blob = await response.blob()
    const text = await blob.text()
    const json = JSON.parse(text)
    console.log(json)
  }
  downloadFile(env.downloadS3Lambda)

  return { env: Object.freeze(env) }
}
