import React from 'react';
import { Badge } from 'antd';
import type { StrategyStatus, OrderState } from '../../types';

type StatusType = StrategyStatus | OrderState;

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  RUNNING:   { color: '#00c896', label: 'RUNNING' },
  COMPLETED: { color: '#4488ff', label: 'COMPLETED' },
  STOPPED:   { color: '#e05252', label: 'STOPPED' },
  PAUSED:    { color: '#ccaa44', label: 'PAUSED' },
  WAITING:   { color: '#555555', label: 'WAITING' },
  ERROR:     { color: '#e05252', label: 'ERROR' },
  OPEN:      { color: '#00c896', label: 'open' },
  FILLED:    { color: '#4488ff', label: 'filled' },
  CANCELLED: { color: '#555555', label: 'cancelled' },
  REJECTED:  { color: '#e05252', label: 'rejected' },
  PARTIALLY_FILLED: { color: '#ccaa44', label: 'partial' },
};

interface StatusBadgeProps {
  status: StatusType;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const cfg = STATUS_CONFIG[status] ?? { color: '#555', label: status };
  return (
    <Badge
      color={cfg.color}
      text={cfg.label}
      style={{ fontSize: 11, color: cfg.color, fontWeight: 600 }}
    />
  );
};
