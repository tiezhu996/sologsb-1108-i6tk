import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { DevRun } from '../types/dev-run'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

export interface AddRunResult {
  id: number
  exceededLimit: boolean
}

export class RunValidationError extends Error {}

interface AddRunOutcome {
  ok: boolean
  id: number
  exceededLimit: boolean
  message: string
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
      const rollCount = Math.floor(Number(payload.rollCount))
      if (!Number.isInteger(rollCount) || rollCount <= 0) {
        throw new RunValidationError('实际冲洗卷数必须是大于 0 的整数')
      }

      const blocked: AddRunOutcome = { ok: false, id: -1, exceededLimit: false, message: '' }

      const outcome = await db.transaction(
        'rw',
        db.runs,
        db.films,
        db.developers,
        db.recipes,
        async (): Promise<AddRunOutcome> => {
          const duplicate = await db.runs.where({ batchNo: payload.batchNo }).count()
          if (duplicate > 0) {
            return {
              ...blocked,
              message: `批次号 ${payload.batchNo} 已存在，同一次冲洗只计一次，胶片与药水均不再重复扣量`
            }
          }

          const recipe = await db.recipes.get(payload.recipeId)
          if (!recipe) {
            return { ...blocked, message: '所选配方不存在，请重新选择配方' }
          }
          const film = await db.films.get(payload.filmId)
          if (!film || film.id === undefined) {
            return { ...blocked, message: '所选乳剂批次不存在，请重新选择胶片批次' }
          }
          const developer = await db.developers.get(recipe.developerId)
          if (!developer || developer.id === undefined) {
            return { ...blocked, message: '该配方未关联显影液，无法登记药水用量' }
          }

          const problems: string[] = []
          if (film.rollsLeft < rollCount) {
            problems.push(
              `胶片侧缺量：乳剂批号 ${film.emulsionNo} 仅剩 ${film.rollsLeft} 卷，本次需要 ${rollCount} 卷`
            )
          }
          if (developer.state === '报废') {
            problems.push(`药水侧不可用：显影液「${developer.name}」已标记报废`)
          }
          if (problems.length > 0) {
            return {
              ...blocked,
              message: `无法保存，${problems.join('；')}。胶片与药水的余量均未变动。`
            }
          }

          const next = { ...payload, rollCount, schemaRev: 3 }
          const id = await db.runs.add(plain(next))
          await db.films.update(film.id, plain({ rollsLeft: film.rollsLeft - rollCount }))
          await db.developers.update(
            developer.id,
            plain({ usedRolls: developer.usedRolls + rollCount })
          )

          return {
            ok: true,
            id,
            exceededLimit: developer.usedRolls + rollCount > developer.maxRolls,
            message: ''
          }
        }
      )

      if (!outcome.ok) {
        throw new RunValidationError(outcome.message)
      }
      await this.load()
      return { id: outcome.id, exceededLimit: outcome.exceededLimit }
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
