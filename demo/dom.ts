// demo/dom.ts

export function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element == null) {
    throw new Error(`Missing required demo element: #${id}`)
  }
  return element as T
}

export function showError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(reason)

  const panel = document.getElementById('error')
  const output = document.getElementById('error-message')
  const status = document.getElementById('status')
  if (panel != null && output != null) {
    panel.hidden = false
    output.textContent = message
  }
  if (status != null) {
    status.textContent = 'Initialization failed'
  }
}
