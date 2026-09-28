import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

export interface AddRunResult {
  id: number
  overCapacity: boolean
}

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addRun(payload: NewRun): Promise<AddRunResult> {
      const batchNo = payload.batchNo.trim()
      const rolls = Math.floor(Number(payload.rolls))
      const problems: string[] = []
      if (!Number.isInteger(rolls) || rolls < 1) {
        problems.push('实际冲洗卷数需为不小于 1 的整数')
      }

      let overCapacity = false
      const id = await db.transaction(
        'rw',
        db.runs,
        db.films,
        db.recipes,
        db.developers,
        async () => {
          const duplicated = await db.runs.where('batchNo').equals(batchNo).first()
          if (duplicated) {
            problems.push(`批次号「${batchNo}」已存在，按同一次实冲处理，不再重复扣减胶片与药水用量`)
          }

          const film = await db.films.get(payload.filmId)
          if (!film || film.id === undefined) {
            problems.push('胶片一侧缺料：未找到所选乳剂批次')
          } else if (rolls >= 1 && film.rollsLeft < rolls) {
            problems.push(`胶片一侧缺料：乳剂批次「${film.emulsionNo}」仅剩 ${film.rollsLeft} 卷，本次需要 ${rolls} 卷`)
          }

          const recipe = await db.recipes.get(payload.recipeId)
          if (!recipe) {
            problems.push('未找到所选冲洗配方')
          }

          const developer = recipe ? await db.developers.get(recipe.developerId) : undefined
          if (recipe && (!developer || developer.id === undefined)) {
            problems.push('药水一侧不可用：未找到配方对应的显影液工作液')
          } else if (developer && developer.state === '报废') {
            problems.push(`药水一侧不可用：显影液「${developer.name}」已报废，请重新配制后再冲洗`)
          }

          if (
            problems.length > 0
            || !film
            || film.id === undefined
            || !developer
            || developer.id === undefined
          ) {
            throw new Error(problems.join('；'))
          }

          overCapacity = developer.usedRolls + rolls > developer.maxRolls
          const next: DevRun = { ...payload, batchNo, rolls, schemaRev: 3 }
          const newId = await db.runs.add(plain(next))
          await db.films.update(
            film.id,
            plain({ rollsLeft: film.rollsLeft - rolls })
          )
          await db.developers.update(
            developer.id,
            plain({ usedRolls: developer.usedRolls + rolls })
          )
          return newId
        }
      )

      await this.load()
      return { id, overCapacity }
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
