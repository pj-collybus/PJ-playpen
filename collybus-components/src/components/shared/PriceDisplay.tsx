import React from 'react';

interface PriceDisplayProps {
  bid: number;
  ask: number;
  tickSize?: number;
  className?: string;
}

function formatPrice(price: number, tickSize: number): string {
  if (!price) return '—';
  const decimals = tickSize < 1
    ? Math.max(0, -Math.floor(Math.log10(tickSize)))
    : 0;
  return price.toFixed(decimals);
}

export const PriceDisplay: React.FC<PriceDisplayProps> = ({
  bid, ask, tickSize = 0.0001
}) => {
  const spread = bid && ask ? ((ask - bid) / ((ask + bid) / 2) * 10000).toFixed(1) : '—';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'monospace' }}>
      <span style={{ color: '#e05252', fontWeight: 700, fontSize: 13 }}>
        {formatPrice(bid, tickSize)}
      </span>
      <span style={{ color: '#555', fontSize: 10 }}>{spread} bps</span>
      <span style={{ color: '#00c896', fontWeight: 700, fontSize: 13 }}>
        {formatPrice(ask, tickSize)}
      </span>
    </div>
  );
};
