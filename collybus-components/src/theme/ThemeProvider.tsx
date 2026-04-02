import React from 'react';
import { ConfigProvider, theme } from 'antd';
import { collybusTokens } from './tokens';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: collybusTokens,
        components: {
          Table: {
            headerBg: '#0a0f18',
            rowHoverBg: '#111927',
            borderColor: '#1e2d3d',
            headerSplitColor: '#1e2d3d',
            cellPaddingBlock: 4,
            cellPaddingInline: 8,
            fontSize: 11,
          },
          Tabs: {
            inkBarColor: '#1890ff',
            itemSelectedColor: '#e8edf2',
            itemColor: '#4a5a6a',
            itemHoverColor: '#8899aa',
            cardBg: '#0a0f18',
            horizontalItemGutter: 0,
          },
          Button: {
            defaultBg: '#0f1520',
            defaultBorderColor: '#1e2d3d',
            defaultColor: '#8899aa',
            primaryShadow: 'none',
            defaultShadow: 'none',
          },
          Input: {
            colorBgContainer: '#0d1117',
            hoverBg: '#0d1117',
            activeBg: '#0d1117',
            hoverBorderColor: '#1890ff',
            activeBorderColor: '#1890ff',
            activeShadow: 'none',
            addonBg: '#0a0f18',
          },
          Select: {
            selectorBg: '#0d1117',
            optionSelectedBg: '#141b26',
          },
          Modal: {
            contentBg: '#080c12',
            headerBg: '#080c12',
            footerBg: '#080c12',
          },
          Drawer: {
            colorBgElevated: '#080c12',
          },
          Card: {
            colorBgContainer: '#0d1117',
            colorBorderSecondary: '#1e2d3d',
          },
          Badge: {
            colorBgContainer: '#0d1117',
          },
          Tag: {
            defaultBg: '#0f1520',
            defaultColor: '#8899aa',
          },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
};
