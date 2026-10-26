import { useConfirm } from './ui'
import { downloadText } from '@/db/csv'

/**
 * CSV is a convenience export and is NOT encrypted. Every unencrypted export goes through an explicit
 * confirmation; the encrypted backup is the recommended way to copy data.
 */
export function usePlainExport() {
  const confirm = useConfirm()
  return async (filename: string, csv: string) => {
    const ok = await confirm({
      title: 'Download an unencrypted file?',
      confirmLabel: 'Download unencrypted CSV',
      danger: false,
      message: <>This CSV is <strong>not encrypted</strong>: anyone who can open the file can read your financial data. Store it somewhere private and delete it when you're done. To keep a protected copy, use <strong>Settings → Encrypted backup</strong> instead.</>,
    })
    if (ok) downloadText(filename, csv, 'text/csv')
  }
}
