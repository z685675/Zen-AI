import { createMigrate } from 'redux-persist'
import { describe, expect, it } from 'vitest'

describe('paintings migration', () => {
  describe('migration 214: legacy image task unification', () => {
    const legacyNamespaces = [
      'siliconflow_paintings',
      'dmxapi_paintings',
      'tokenflux_paintings',
      'zhipu_paintings',
      'aihubmix_image_generate',
      'aihubmix_image_remix',
      'aihubmix_image_edit',
      'aihubmix_image_upscale',
      'openai_image_edit',
      'ovms_paintings',
      'ppio_draw',
      'ppio_edit'
    ]

    const providerByNamespace: Record<string, string> = {
      siliconflow_paintings: 'siliconflow',
      dmxapi_paintings: 'dmxapi',
      tokenflux_paintings: 'tokenflux',
      zhipu_paintings: 'zhipu',
      aihubmix_image_generate: 'aihubmix',
      aihubmix_image_remix: 'aihubmix',
      aihubmix_image_edit: 'aihubmix',
      aihubmix_image_upscale: 'aihubmix',
      openai_image_edit: 'openai',
      ovms_paintings: 'ovms',
      ppio_draw: 'ppio',
      ppio_edit: 'ppio'
    }

    const migrate214 = (state: any) => {
      const imageWorkspacePaintings = Array.isArray(state.paintings.openai_image_generate)
        ? state.paintings.openai_image_generate
        : []
      const existingIds = new Set(imageWorkspacePaintings.map((painting: any) => painting.id).filter(Boolean))
      const migratedPaintings: any[] = []

      legacyNamespaces.forEach((namespace) => {
        const paintings = state.paintings?.[namespace]
        if (!Array.isArray(paintings)) {
          return
        }

        paintings.forEach((painting: any) => {
          if (!painting?.id || existingIds.has(painting.id)) {
            return
          }

          existingIds.add(painting.id)
          migratedPaintings.push({
            ...painting,
            providerId: painting.providerId || providerByNamespace[namespace],
            migratedFromNamespace: namespace
          })
        })
      })

      state.paintings.openai_image_generate = [...imageWorkspacePaintings, ...migratedPaintings]
      return state
    }

    const migrate = createMigrate({ '214': migrate214 as any })

    it('copies legacy tasks into the unified image workspace without deleting old namespaces', async () => {
      const state = {
        paintings: {
          openai_image_generate: [{ id: 'new-task', prompt: 'already unified', files: [], urls: [] }],
          siliconflow_paintings: [{ id: 'legacy-silicon', prompt: 'old silicon', files: [], urls: [] }],
          ppio_draw: [{ id: 'legacy-ppio', prompt: 'old ppio', providerId: 'custom-ppio', files: [], urls: [] }]
        },
        _persist: { version: 213, rehydrated: false }
      }

      const migrated: any = await migrate(state, 214)

      expect(migrated.paintings.openai_image_generate).toEqual([
        { id: 'new-task', prompt: 'already unified', files: [], urls: [] },
        {
          id: 'legacy-silicon',
          prompt: 'old silicon',
          files: [],
          urls: [],
          providerId: 'siliconflow',
          migratedFromNamespace: 'siliconflow_paintings'
        },
        {
          id: 'legacy-ppio',
          prompt: 'old ppio',
          providerId: 'custom-ppio',
          files: [],
          urls: [],
          migratedFromNamespace: 'ppio_draw'
        }
      ])
      expect(migrated.paintings.siliconflow_paintings).toHaveLength(1)
      expect(migrated.paintings.ppio_draw).toHaveLength(1)
    })

    it('does not duplicate tasks that already exist in the unified workspace', async () => {
      const state = {
        paintings: {
          openai_image_generate: [{ id: 'same-task', prompt: 'unified copy', files: [], urls: [] }],
          dmxapi_paintings: [{ id: 'same-task', prompt: 'legacy copy', files: [], urls: [] }]
        },
        _persist: { version: 213, rehydrated: false }
      }

      const migrated: any = await migrate(state, 214)

      expect(migrated.paintings.openai_image_generate).toEqual([
        { id: 'same-task', prompt: 'unified copy', files: [], urls: [] }
      ])
      expect(migrated.paintings.dmxapi_paintings).toEqual([
        { id: 'same-task', prompt: 'legacy copy', files: [], urls: [] }
      ])
    })
  })
})
