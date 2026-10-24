export interface ImageStudioBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface ImageStudioOpen {
  apiHost: string
  apiKey: string
  bounds: ImageStudioBounds
}

export function imageStudioOrigin(host: string): string {
  const url = new URL(host)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_studio_origin')
  return url.origin
}

export function imageStudioBounds(value: ImageStudioBounds): ImageStudioBounds {
  if (
    !value ||
    ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
    value.width < 1 ||
    value.height < 1 ||
    value.x < 0 ||
    value.y < 0 ||
    value.width > 20000 ||
    value.height > 20000
  )
    throw new Error('invalid_studio_bounds')
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height)
  }
}
