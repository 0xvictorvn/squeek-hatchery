/** A failed response body must reject; an empty success can corrupt client state. */
export async function readApiJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
