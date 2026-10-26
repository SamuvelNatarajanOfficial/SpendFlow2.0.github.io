import { db } from './db'
import { categories, transactions } from './repo'
import { categoryColorFor, type ImportPreview } from './csv'

/** Applies a previewed CSV import. Error rows are never imported; duplicates only when explicitly included. */
export async function applyCsvImport(preview: ImportPreview, includeDuplicates: boolean): Promise<{ imported: number; categoriesCreated: number }> {
  const rows = preview.rows.filter((r) => r.tx && (r.status === 'ok' || (includeDuplicates && r.status === 'duplicate')))
  let created = 0
  const idByKey = new Map<string, string>()
  const all = await db.categories.toArray()
  for (const r of rows) {
    if (!r.newCategory) continue
    const key = `${r.newCategory.kind}|${r.newCategory.name.toLowerCase()}`
    if (idByKey.has(key)) continue
    const found = all.find((c) => c.kind === r.newCategory!.kind && c.name.toLowerCase() === r.newCategory!.name.toLowerCase())
    if (found) {
      idByKey.set(key, found.id)
      continue
    }
    const c = await categories.create({ name: r.newCategory.name, kind: r.newCategory.kind, color: categoryColorFor(all.length + created) })
    created++
    idByKey.set(key, c.id)
  }
  const inputs = rows.map((r) => {
    const tx = { ...r.tx! }
    if (r.newCategory) tx.categoryId = idByKey.get(`${r.newCategory.kind}|${r.newCategory.name.toLowerCase()}`)
    return tx
  })
  const imported = await transactions.bulkCreate(inputs)
  return { imported, categoriesCreated: created }
}
