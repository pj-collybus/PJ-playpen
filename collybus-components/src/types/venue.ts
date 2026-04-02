export interface VenueConfig {
  id: string;
  displayName: string;
  exchangeColor: string;
  exchangeBg: string;
  assetClasses: string[];
  testnet: boolean;
  supportsOptions: boolean;
}

export interface ExchangeCredentials {
  exchange: string;
  fields: Record<string, string>;
  testnet: boolean;
  permissions: string[];
}
