/// <reference types="vite/client" />

import type { MorrowApi } from '@shared/contracts'

declare global {
  interface Window {
    morrow: MorrowApi
  }
}

export {}
