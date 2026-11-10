/**
 * Fetch with exponential backoff retry for transient server errors (5xx).
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(input, init)
      if (response.ok || response.status < 500 || attempt >= retries) return response
    } catch (err) {
      if (attempt >= retries) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
  }
}
