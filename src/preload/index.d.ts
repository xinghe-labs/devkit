import type { DevkitApi } from '@shared/api'

declare global {
  interface Window {
    devkit: DevkitApi
  }
}

export {}
