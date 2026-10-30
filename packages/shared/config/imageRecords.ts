import type { ImageCanvasTask } from './imageCanvas'

export type ImageCanvasRecord<T extends ImageCanvasTask = ImageCanvasTask> = {
  id: string
  latest: T
  tasks: T[]
  status: ImageCanvasTask['status']
}

// A submission is one visible record; its individual requests retain their
// original IDs for billing evidence, recovery and diagnostics.
export function groupImageCanvasTasks<T extends ImageCanvasTask>(tasks: readonly T[]): ImageCanvasRecord<T>[] {
  const groups = new Map<string, T[]>()
  const ordered = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  for (const task of ordered) {
    const id = task.batchId ? `batch:${task.batchId}` : `task:${task.id}`
    const group = groups.get(id) ?? []
    group.push(task)
    groups.set(id, group)
  }
  return [...groups].map(([id, members]) => ({
    id,
    latest: members[0],
    tasks: [...members].reverse(),
    status: members.some((task) => task.status === 'running')
      ? 'running'
      : members.every((task) => task.status === 'completed')
        ? 'completed'
        : members.some((task) => task.status === 'uncertain' || task.assets.length > 0)
          ? 'uncertain'
          : 'failed'
  }))
}
