import React from 'react';
import { Tag } from 'antd';

const EXCHANGE_COLORS: Record<string, { color: string; bg: string }> = {
  DERIBIT: { color: '#e03040', bg: '#2a080e' },
  BINANCE: { color: '#f0b90b', bg: '#2a2008' },
  BYBIT:   { color: '#f7a600', bg: '#2a1e08' },
  OKX:     { color: '#aaaaaa', bg: '#1a1a1a' },
  KRAKEN:  { color: '#8d5ff0', bg: '#100820' },
  BITMEX:  { color: '#4a90d9', bg: '#081420' },
  LMAX:    { color: '#cc8844', bg: '#1e1408' },
  EBS:     { color: '#5588cc', bg: '#081420' },
};

interface ExchangePillProps {
  exchange: string;
  size?: 'small' | 'default';
}

export const ExchangePill: React.FC<ExchangePillProps> = ({ exchange, size = 'small' }) => {
  const cfg = EXCHANGE_COLORS[exchange.toUpperCase()] ?? { color: '#888', bg: '#1a1a1a' };
  return (
    <Tag
      style={{
        backgroundColor: cfg.bg,
        borderColor: cfg.color,
        color: cfg.color,
        fontSize: size === 'small' ? 9 : 11,
        fontWeight: 700,
        padding: size === 'small' ? '0 4px' : '1px 6px',
        lineHeight: '16px',
        margin: 0,
        letterSpacing: '0.05em',
      }}
    >
      {exchange.toUpperCase()}
    </Tag>
  );
};
