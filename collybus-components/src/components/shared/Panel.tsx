import React, { useRef, useCallback } from 'react';
import { Card } from 'antd';

interface PanelProps {
  id: string;
  title: React.ReactNode;
  children: React.ReactNode;
  x: number;
  y: number;
  width?: number;
  minWidth?: number;
  minHeight?: number;
  onMove?: (id: string, x: number, y: number) => void;
  onResize?: (id: string, width: number, height: number) => void;
  style?: React.CSSProperties;
  headerExtra?: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = ({
  id, title, children, x, y, width = 460,
  minWidth = 320, minHeight = 200,
  onMove, headerExtra, style,
}) => {
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, .ant-btn')) return;
    e.preventDefault();
    const el = elRef.current;
    if (!el) return;
    dragRef.current = {
      ox: e.clientX - el.offsetLeft,
      oy: e.clientY - el.offsetTop,
    };
    const onMove_ = (ev: MouseEvent) => {
      if (!dragRef.current || !el) return;
      const newX = Math.max(0, ev.clientX - dragRef.current.ox);
      const newY = Math.max(0, ev.clientY - dragRef.current.oy);
      el.style.left = newX + 'px';
      el.style.top = newY + 'px';
      onMove?.(id, newX, newY);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove_);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove_);
    document.addEventListener('mouseup', onUp);
  }, [id, onMove]);

  return (
    <div
      ref={elRef}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        minWidth,
        minHeight,
        zIndex: 1,
        ...style,
      }}
    >
      <Card
        size="small"
        styles={{
          header: {
            cursor: 'grab',
            userSelect: 'none',
            padding: '4px 10px',
            minHeight: 32,
            borderBottom: '1px solid #1a1a22',
          },
          body: { padding: 0, overflow: 'hidden' },
        }}
        title={<div onMouseDown={onMouseDown}>{title}</div>}
        extra={headerExtra}
        style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        {children}
      </Card>
    </div>
  );
};
