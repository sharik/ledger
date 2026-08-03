import type { Vault } from '../model/types'
import { derive, todayStr } from '../model/selectors'

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const csvEscape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function exportCsv(vault: Vault): string {
  const d = derive(vault)
  const rows = [['date', 'merchant', 'category', 'amount', 'note']]
  for (const t of [...d.txnsSorted].reverse()) {
    rows.push([
      t.date,
      csvEscape(t.merchant),
      csvEscape(d.catById.get(t.categoryId)?.name ?? ''),
      String(t.amount),
      csvEscape(t.note ?? ''),
    ])
  }
  const csv = rows.map((r) => r.join(',')).join('\n')
  const name = `ledger_${todayStr()}.csv`
  download(name, 'text/csv', csv)
  return name
}

/**
 * A copy of the vault with every stored LLM API key blanked. The JSON export is data portability, not
 * an encrypted backup, and there is no import path that would need the keys back — so shipping them in a
 * plaintext file a user might share is pure leak. Base URLs stay: they are not credentials.
 */
export function redactVault(vault: Vault): Vault {
  const a = vault.settings.assist
  if (!a) return vault
  return {
    ...vault,
    settings: {
      ...vault.settings,
      assist: {
        ...a,
        apiKey: '',
        perProvider: a.perProvider
          ? Object.fromEntries(
              Object.entries(a.perProvider).map(([id, c]) => [id, { ...c, apiKey: undefined }]),
            )
          : undefined,
      },
    },
  }
}

export function exportJson(vault: Vault): string {
  const name = `ledger_${todayStr()}.json`
  download(name, 'application/json', JSON.stringify(redactVault(vault), null, 2))
  return name
}
