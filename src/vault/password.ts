/**
 * Password guidance. This is a HEURISTIC entropy estimate, not a guarantee: it cannot know whether a phrase was
 * chosen randomly. It rejects short, common, repetitive or sequential passwords and encourages long passphrases.
 */
export const MIN_PASSWORD_LENGTH = 12

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd1234', 'qwertyuiop', 'qwertyuiop12', 'qwerty123456',
  '123456789012', '1234567890123', '111111111111', '000000000000', 'abcdefghijkl', 'iloveyou1234', 'welcome12345', 'admin1234567',
  'letmein12345', 'changeme1234', 'spendflow', 'spendflow123', 'spendflow2024', 'spendflow2025', 'spendflow2026', 'financepassword',
  'mypassword123', 'monkey123456', 'dragon123456', 'sunshine1234', 'football1234', 'baseball1234', 'princess1234', 'trustno1trustno1',
])

export interface PasswordAssessment {
  score: 0 | 1 | 2 | 3 | 4
  label: 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong'
  acceptable: boolean
  hints: string[]
  bits: number
}

const KEYBOARD = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

/**
 * Number of characters that sit inside a predictable run of 4+: consecutive code points ("abcd", "4321") or a
 * keyboard row ("qwer", "asdf"), forwards or backwards. Such runs add almost no entropy.
 */
function sequentialChars(p: string): number {
  const s = p.toLowerCase()
  const inRun = new Array<boolean>(s.length).fill(false)
  let start = 0
  for (let i = 1; i <= s.length; i++) {
    const step = i < s.length ? s.charCodeAt(i) - s.charCodeAt(i - 1) : 0
    const prev = i - 1 > start ? s.charCodeAt(i - 1) - s.charCodeAt(i - 2) : step
    if (i < s.length && Math.abs(step) === 1 && (i - 1 === start || step === prev)) continue
    if (i - start >= 4) for (let k = start; k < i; k++) inRun[k] = true
    start = i
  }
  for (const row of KEYBOARD) {
    for (const r of [row, [...row].reverse().join('')]) {
      for (let len = 4; len <= r.length; len++) {
        for (let i = 0; i + len <= r.length; i++) {
          const frag = r.slice(i, i + len)
          let at = s.indexOf(frag)
          while (at !== -1) {
            for (let k = at; k < at + len; k++) inRun[k] = true
            at = s.indexOf(frag, at + 1)
          }
        }
      }
    }
  }
  return inRun.filter(Boolean).length
}

export function assessPassword(pw: string): PasswordAssessment {
  const p = pw.normalize('NFKC')
  const hints: string[] = []
  const lower = p.toLowerCase().replace(/[^a-z0-9]/g, '')
  const common = COMMON.has(lower) || COMMON.has(p.toLowerCase())

  const pool = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0) + (/[0-9]/.test(p) ? 10 : 0) + (/[^A-Za-z0-9]/.test(p) ? 33 : 0)
  const unique = new Set(p).size
  // repeated characters add little: count unique chars fully and the rest at a discount
  const effective = unique + Math.max(0, p.length - unique) * 0.4
  const seq = sequentialChars(p)
  // predictable runs are worth ~1 bit per character instead of log2(pool)
  let bits = pool > 0 ? Math.log2(pool) * Math.max(0, effective - seq) + seq : 0
  if (common) bits = Math.min(bits, 10)
  if (/^(.)\1+$/.test(p)) bits = 0
  bits = Math.round(bits)

  if (p.length < MIN_PASSWORD_LENGTH) hints.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  if (common) hints.push('This is a very common password.')
  if (/^[0-9]+$/.test(p)) hints.push('Digits only is easy to guess.')
  if (seq >= 4) hints.push('Avoid sequences like "abcd", "1234" or keyboard runs like "qwerty".')
  if (unique < Math.min(p.length, 8)) hints.push('Avoid repeating the same characters.')
  if (hints.length === 0 && bits < 60) hints.push('Longer is better: try a passphrase of 4+ unrelated words.')

  const score = (bits < 30 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4) as PasswordAssessment['score']
  const acceptable = p.length >= MIN_PASSWORD_LENGTH && !common && score >= 2
  return { score, label: (['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const)[score], acceptable, hints, bits }
}
