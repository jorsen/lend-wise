export function toCSV(rows: (string | number)[][]) {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c ?? '')
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\r\n')
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') inQuotes = false
      else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',' || ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim()))
}

/**
 * Reads a member list. Accepts a header row containing "CID" and "Name"/"Member Name"
 * in any order; without a header, assumes column 1 = CID, column 2 = name.
 */
export function parseMemberCSV(text: string) {
  const rows = parseCSV(text)
  if (!rows.length) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  let cidIdx = header.findIndex((h) => h === 'cid' || h.includes('cid'))
  let nameIdx = header.findIndex((h) => h.includes('name'))
  let body = rows
  if (cidIdx >= 0 || nameIdx >= 0) {
    body = rows.slice(1)
  } else {
    cidIdx = 0
    nameIdx = 1
  }
  return body
    .map((r) => ({ cid: (cidIdx >= 0 ? r[cidIdx] : '') ?? '', name: (nameIdx >= 0 ? r[nameIdx] : '') ?? '' }))
    .filter((r) => r.name.trim())
}

export function downloadFile(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([type.startsWith('text/csv') ? '﻿' + content : content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function readFileText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}
