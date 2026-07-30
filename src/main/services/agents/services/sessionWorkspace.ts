export const haveSameAccessiblePaths = (left: string[] | undefined, right: string[] | undefined): boolean => {
  if (!left || !right || left.length !== right.length) return false
  return left.every((path, index) => path === right[index])
}
