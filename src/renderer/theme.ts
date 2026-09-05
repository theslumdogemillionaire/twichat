import type { Theme } from '../shared/types'
import { themeName } from '../shared/validation'

let current: Theme = 'system'

export function currentTheme(): Theme { return current }

/**
 * `system` writes nothing on the root: the stylesheet then falls back to
 * `prefers-color-scheme`, which the main process drives through `nativeTheme`.
 */
export function applyTheme(theme: Theme): void {
  current = theme
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=theme]')) input.checked = input.value === theme
}

export function setupTheme(initial: Theme, onChange: (theme: Theme) => void): void {
  applyTheme(initial)
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=theme]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return
      applyTheme(themeName(input.value))
      onChange(current)
    })
  }
}
