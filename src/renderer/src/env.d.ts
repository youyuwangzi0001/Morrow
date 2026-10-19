/// <reference types="vite/client" />

import type { MorrowApi } from '@shared/ipc'

declare global {
  interface Window {
    morrow: MorrowApi
  }
}

export {}
