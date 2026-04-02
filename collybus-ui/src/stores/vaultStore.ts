import { create } from 'zustand'

export interface ExchangeCredentials {
  exchange: string
  fields: Record<string, string>
  testnet: boolean
}

interface VaultStore {
  unlocked: boolean
  credentials: Record<string, ExchangeCredentials>
  unlock: (password: string) => Promise<void>
  lock: () => void
  saveCredential: (exchange: string, creds: ExchangeCredentials) => Promise<void>
}

export const useVaultStore = create<VaultStore>((set) => ({
  unlocked: false,
  credentials: {},
  unlock: async (_password: string) => {
    // TODO: implement Web Crypto vault decryption
    set({ unlocked: true })
  },
  lock: () => set({ unlocked: false, credentials: {} }),
  saveCredential: async (exchange, creds) => {
    set((s) => ({
      credentials: { ...s.credentials, [exchange]: creds },
    }))
  },
}))
