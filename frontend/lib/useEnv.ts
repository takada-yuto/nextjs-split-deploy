import useSWR from "swr"

interface Env {
  cloudfrontUrl: string
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
        cloudfrontUrl: "not found",
      }) as Env,
    }
  }
  console.log(env)

  const downloadFile = async (url: string) => {
    const downloadResponse = await fetch("/create-presigned-url", {
      // 途中
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: url }),
    })
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
  downloadFile(env.cloudfrontUrl)

  return { env: Object.freeze(env) }
}
