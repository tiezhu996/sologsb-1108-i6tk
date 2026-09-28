<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import FilterBar from '../components/common/FilterBar.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore, RunValidationError } from '../stores/runStore'
import type { TankType } from '../types/dev-run'

interface FilterValue {
  keyword: string
  selections: Record<string, string[]>
}

interface RunForm {
  batchNo: string
  recipeId: number
  filmId: number
  rollCount: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

const route = useRoute()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const showForm = ref(false)
const saving = ref(false)
const today = new Date().toISOString().slice(0, 10)

const querySelections = (key: string): string[] => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value.split(',') : []
}

const filterValue = ref<FilterValue>({
  keyword: typeof route.query.q === 'string' ? route.query.q : '',
  selections: {
    tankType: querySelections('tankType'),
    result: querySelections('result')
  }
})

const form = reactive<RunForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  filmId: 1,
  rollCount: 2,
  actualTempC: 20,
  actualMinutes: 8,
  tankType: '双联罐',
  runDate: today,
  result: '密度均匀，中间调细腻'
})

const selectedRecipe = computed(() => recipeStore.recipes.find((recipe) => recipe.id === form.recipeId))
const selectedFilm = computed(() => filmStore.films.find((film) => film.id === form.filmId))
const selectedDeveloper = computed(() =>
  developerStore.developers.find((item) => item.id === selectedRecipe.value?.developerId)
)
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)
const { suggest } = useTempCompensate(referenceTemp)
const suggestion = computed(() => {
  const recipe = selectedRecipe.value
  if (!recipe) return null
  return suggest(recipe.devMinutes, form.actualTempC)
})

watch(selectedRecipe, (recipe) => {
  if (!recipe) return
  form.actualTempC = recipe.tempC
  form.actualMinutes = recipe.devMinutes
  if (!form.filmId) {
    form.filmId = recipe.filmId
  }
}, { immediate: true })

const filteredRuns = computed(() => {
  const keyword = filterValue.value.keyword.trim().toLowerCase()
  const tankTypes = filterValue.value.selections.tankType ?? []
  const results = filterValue.value.selections.result ?? []
  return runStore.runs.filter((run) => {
    const recipe = recipeStore.recipes.find((item) => item.id === run.recipeId)
    const film = filmStore.films.find((item) => item.id === run.filmId)
      ?? filmStore.films.find((item) => item.id === recipe?.filmId)
    const haystack = `${run.batchNo} ${run.result} ${film?.model ?? ''} ${film?.emulsionNo ?? ''}`.toLowerCase()
    const matchesKeyword = !keyword || haystack.includes(keyword)
    const matchesTank = tankTypes.length === 0 || tankTypes.includes(run.tankType)
    const matchesResult = results.length === 0 || results.some((item) => run.result.includes(item))
    return matchesKeyword && matchesTank && matchesResult
  })
})

function filmForRun(run: { filmId?: number; recipeId: number }) {
  return filmStore.films.find((item) => item.id === run.filmId)
    ?? filmStore.films.find((item) => item.id === recipeForRun(run.recipeId)?.filmId)
}

function recipeLabel(id: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === id)
  if (!recipe) return '未知配方'
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  const developer = developerStore.developers.find((item) => item.id === recipe.developerId)
  return `${film?.model ?? '未知胶片'} · ${developer?.name ?? '未知显影液'} · ${recipe.tempC}°C`
}

function recipeForRun(id: number) {
  return recipeStore.recipes.find((item) => item.id === id)
}

function applySuggestion(): void {
  if (!suggestion.value) return
  form.actualMinutes = suggestion.value.minutes
}

async function submitRun(): Promise<void> {
  if (!form.batchNo.trim() || !form.recipeId || !form.filmId || !form.result.trim()) {
    ElMessage.warning('请填写批次号、乳剂批次、配方与结果评价')
    return
  }
  const rollCount = Math.floor(Number(form.rollCount))
  if (!Number.isInteger(rollCount) || rollCount <= 0) {
    ElMessage.warning('实际冲洗卷数必须是大于 0 的整数')
    return
  }
  saving.value = true
  try {
    const { exceededLimit } = await runStore.addRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      filmId: Number(form.filmId),
      rollCount,
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      tankType: form.tankType,
      runDate: form.runDate,
      result: form.result.trim()
    })
    await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load()])
    if (exceededLimit) {
      ElMessage.warning(`冲洗记录已保存，本次 ${rollCount} 卷已超过显影液标称可冲上限，请评估后标记报废`)
    } else {
      ElMessage.success(`冲洗记录已保存，胶片与显影液均按 ${rollCount} 卷同步扣量`)
    }
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    form.rollCount = 1
    form.result = ''
    showForm.value = false
  } catch (error) {
    if (error instanceof RunValidationError) {
      ElMessage.error(error.message)
    } else {
      throw error
    }
  } finally {
    saving.value = false
  }
}

async function writeBack(recipeId?: number, runId?: number): Promise<void> {
  if (recipeId === undefined || runId === undefined) return
  await runStore.writeBackNote(runId, recipeId)
  await recipeStore.load()
  ElMessage.success('本次实冲结果已回写配方注释')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), recipeStore.load(), runStore.load()])
  const firstRecipe = recipeStore.recipes[0]
  if (firstRecipe?.id !== undefined) {
    form.recipeId = firstRecipe.id
    form.filmId = firstRecipe.filmId
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗记录与结果评价</h1>
        <p>记录每一次实测温度、实际时间与样片结果，让下一批参数来自真实经验。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建冲洗记录' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="submitRun">
      <div class="inline-form__head">
        <div>
          <h2>录入本次实冲</h2>
          <p>选择配方后会自动带入基准条件，可依据实测温度一键采用修正时间。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>冲洗配方</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeStore.recipes" :key="recipe.id" :value="recipe.id">
              {{ recipeLabel(recipe.id ?? 0) }}
            </option>
          </select>
        </label>
        <label class="span-2">
          <span>乳剂批次</span>
          <select v-model.number="form.filmId" data-testid="field-filmId">
            <option v-for="film in filmStore.films" :key="film.id" :value="film.id">
              {{ film.model }} · {{ film.format }} · {{ film.emulsionNo }}（余 {{ film.rollsLeft }} 卷）
            </option>
          </select>
        </label>
        <label>
          <span>实际冲洗卷数</span>
          <input v-model.number="form.rollCount" data-testid="field-rollCount" type="number" min="1" max="99" step="1" />
        </label>
        <label>
          <span>实测温度</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实际时间</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label class="span-2">
          <span>结果评价</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="记录反差、灰雾与密度表现" />
        </label>
        <div class="span-3 stock-check-callout" data-testid="stock-check">
          <div>
            <strong>本次扣量核对</strong>
            <p>
              乳剂批次
              <template v-if="selectedFilm">
                「{{ selectedFilm.emulsionNo }}」剩余 {{ selectedFilm.rollsLeft }} 卷，
                <span :class="{ 'text-danger': selectedFilm.rollsLeft < form.rollCount }">
                  {{ selectedFilm.rollsLeft < form.rollCount
                    ? `本次缺 ${form.rollCount - selectedFilm.rollsLeft} 卷（胶片侧）`
                    : `本次冲 ${form.rollCount} 卷后余 ${selectedFilm.rollsLeft - form.rollCount} 卷` }}
                </span>
              </template>
              <template v-else>请选择乳剂批次</template>
              ；显影液
              <template v-if="selectedDeveloper">
                「{{ selectedDeveloper.name }}」已用 {{ selectedDeveloper.usedRolls }} / {{ selectedDeveloper.maxRolls }} 卷，
                <span :class="{ 'text-danger': selectedDeveloper.state === '报废' }">
                  {{ selectedDeveloper.state === '报废'
                    ? '已报废，不能再用（药水侧）'
                    : `本次加 ${form.rollCount} 卷${selectedDeveloper.usedRolls + form.rollCount > selectedDeveloper.maxRolls ? '，将超过标称上限' : ''}` }}
                </span>
              </template>
              <template v-else>请选择配方</template>
            </p>
          </div>
        </div>
        <div class="span-3 compensation-callout">
          <div>
            <strong>温度补偿建议</strong>
            <p v-if="suggestion">{{ suggestion.advice }}；保存后显影液用量按 {{ form.rollCount }} 卷增加。</p>
            <p v-else>请选择一条配方后查看修正建议。</p>
          </div>
          <button type="button" class="ghost-button" :disabled="!suggestion" @click="applySuggestion">采用修正时间</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-run" :disabled="saving">
          {{ saving ? '保存中…' : '保存冲洗记录' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>记录总数</span><strong data-testid="count-run">{{ runStore.runs.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>当前筛选</span><strong>{{ filteredRuns.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>回写配方</span><strong>{{ recipeStore.recipes.filter((item) => item.note).length }}</strong><small>条</small></div>
    </div>

    <FilterBar
      v-model="filterValue"
      :fields="[
        { key: 'tankType', label: '罐型', options: ['双联罐', '深罐'] },
        { key: 'result', label: '结果特点', options: ['密度均匀', '暗部略薄', '反差稍强', '高光保留', '灰雾'] }
      ]"
    />

    <div v-if="filteredRuns.length" class="run-list">
      <article v-for="run in filteredRuns" :key="run.id" class="run-card" data-testid="row-run">
        <div class="run-card__date">
          <strong>{{ run.runDate.slice(5) }}</strong>
          <span>{{ run.runDate.slice(0, 4) }}</span>
        </div>
        <div class="run-card__body">
          <div class="entity-card__title">
            <div>
              <h2>{{ run.batchNo }}</h2>
              <p>{{ recipeLabel(run.recipeId) }}</p>
            </div>
            <PushPullTag v-if="recipeForRun(run.recipeId)" :value="recipeForRun(run.recipeId)?.pushPull ?? 'N'" />
          </div>
          <div class="run-parameters">
            <span><small>乳剂批次</small><strong data-testid="cell-emulsion">{{ filmForRun(run)?.emulsionNo ?? '未知批次' }}</strong></span>
            <span><small>冲洗卷数</small><strong data-testid="cell-rollCount">{{ run.rollCount ?? 1 }} 卷</strong></span>
            <span><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
            <span><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
            <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
          </div>
          <blockquote>{{ run.result }}</blockquote>
          <div class="run-card__foot">
            <small v-if="recipeForRun(run.recipeId)?.note">配方注释：{{ recipeForRun(run.recipeId)?.note }}</small>
            <button type="button" class="text-button" @click="writeBack(run.recipeId, run.id)">回写配方注释</button>
          </div>
        </div>
      </article>
    </div>
    <EmptyPanel v-else title="没有符合条件的冲洗记录" description="调整罐型、结果特点或关键字后重新查看。" />
  </section>
</template>
