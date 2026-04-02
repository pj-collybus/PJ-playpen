import { useState, useEffect } from 'react'
import { Modal, Form, Input, Select, Switch, Button, Table, Tag, Space, Popconfirm, App as AntApp } from 'antd'
import { PlusOutlined, CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { api } from '../../services/apiClient'

interface KeyEntry {
  id: string
  exchange: string
  label: string
  testnet: boolean
  permissions: string
  status: string
  lastTested?: string
  fields: Record<string, string | null>
}

const EXCHANGE_FIELDS: Record<string, { key: string; label: string; secret: boolean }[]> = {
  Deribit: [
    { key: 'clientId', label: 'Client ID', secret: false },
    { key: 'clientSecret', label: 'Client Secret', secret: true },
  ],
  BitMEX: [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'apiSecret', label: 'API Secret', secret: true },
  ],
  Binance: [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'secretKey', label: 'Secret Key', secret: true },
  ],
  Bybit: [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'secretKey', label: 'Secret Key', secret: true },
  ],
  OKX: [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'secretKey', label: 'Secret Key', secret: true },
    { key: 'passphrase', label: 'Passphrase', secret: true },
  ],
  Kraken: [
    { key: 'apiKey', label: 'API Key', secret: false },
    { key: 'privateKey', label: 'Private Key', secret: true },
  ],
}

const EXCHANGES = Object.keys(EXCHANGE_FIELDS)

interface ExchangeManagerProps {
  open: boolean
  onClose: () => void
}

export function ExchangeManager({ open, onClose }: ExchangeManagerProps) {
  const [keys, setKeys] = useState<KeyEntry[]>([])
  const [adding, setAdding] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const selectedExchange = Form.useWatch('exchange', form)

  useEffect(() => {
    if (open) loadKeys()
  }, [open])

  const loadKeys = async () => {
    const r = await api.get('/keys')
    setKeys(r.data.keys || [])
  }

  const handleSave = async (values: Record<string, unknown>) => {
    const fields: Record<string, string> = {}
    const fieldDefs = EXCHANGE_FIELDS[values.exchange as string] || []
    for (const f of fieldDefs) {
      if (values[f.key]) fields[f.key] = values[f.key] as string
    }
    const r = await api.post('/keys', {
      exchange: values.exchange,
      label: values.label,
      testnet: values.testnet,
      permissions: 'read_write',
      fields,
    })
    if (r.data.ok) {
      message.success('Credentials saved')
      setAdding(false)
      form.resetFields()
      loadKeys()
    } else {
      message.error(r.data.error || 'Failed to save')
    }
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      const r = await api.post(`/keys/${id}/test`)
      if (r.data.ok) message.success(r.data.message)
      else message.error(r.data.message)
      loadKeys()
    } catch {
      message.error('Test failed')
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (id: string) => {
    await api.delete(`/keys/${id}`)
    loadKeys()
  }

  const handleConnect = async () => {
    const exchanges = keys.map(k => k.exchange.toUpperCase())
    const r = await api.post('/keys/subscribe-private', { exchanges })
    if (r.data.ok) {
      message.success('Private channels connected')
      onClose()
    }
  }

  const statusIcon = (status: string) => {
    if (status === 'ok') return <CheckCircleOutlined style={{ color: '#00d4aa' }} />
    if (status === 'error') return <CloseCircleOutlined style={{ color: '#ff4d6a' }} />
    return <QuestionCircleOutlined style={{ color: '#4a5a6a' }} />
  }

  const columns = [
    { title: 'Exchange', dataIndex: 'exchange', key: 'exchange',
      render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: 'Label', dataIndex: 'label', key: 'label' },
    { title: 'Testnet', dataIndex: 'testnet', key: 'testnet',
      render: (v: boolean) => v ? <Tag color="orange">Testnet</Tag> : <Tag color="green">Live</Tag> },
    { title: 'Status', dataIndex: 'status', key: 'status',
      render: (v: string) => <Space>{statusIcon(v)}<span style={{ color: '#8899aa', fontSize: 11 }}>{v}</span></Space> },
    { title: '', key: 'actions',
      render: (_: unknown, record: KeyEntry) => (
        <Space>
          <Button size="small" loading={testing === record.id}
            onClick={() => handleTest(record.id)}>Test</Button>
          <Popconfirm title="Delete this key?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger>Delete</Button>
          </Popconfirm>
        </Space>
      )},
  ]

  return (
    <Modal
      title="Exchange Credentials"
      open={open}
      onCancel={onClose}
      width={700}
      footer={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button icon={<PlusOutlined />} onClick={() => setAdding(!adding)}>
            Add Credentials
          </Button>
          <Space>
            <Button onClick={onClose}>Close</Button>
            <Button type="primary" onClick={handleConnect} disabled={keys.length === 0}>
              Connect All
            </Button>
          </Space>
        </Space>
      }
    >
      <Table
        dataSource={keys}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={false}
        style={{ marginBottom: adding ? 16 : 0 }}
      />

      {adding && (
        <Form form={form} layout="vertical" onFinish={handleSave}
          style={{ marginTop: 16, padding: 16, background: '#0a0f18', borderRadius: 6, border: '1px solid #1e2d3d' }}>
          <Form.Item name="exchange" label="Exchange" rules={[{ required: true }]}>
            <Select options={EXCHANGES.map(e => ({ value: e, label: e }))} placeholder="Select exchange" />
          </Form.Item>
          <Form.Item name="label" label="Label" rules={[{ required: true }]}>
            <Input placeholder="e.g. Main Trading" />
          </Form.Item>
          <Form.Item name="testnet" label="Testnet" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          {selectedExchange && EXCHANGE_FIELDS[selectedExchange]?.map(f => (
            <Form.Item key={f.key} name={f.key} label={f.label}>
              <Input.Password visibilityToggle={false} placeholder={f.secret ? '••••••••' : ''} />
            </Form.Item>
          ))}
          <Space>
            <Button type="primary" htmlType="submit">Save</Button>
            <Button onClick={() => { setAdding(false); form.resetFields() }}>Cancel</Button>
          </Space>
        </Form>
      )}
    </Modal>
  )
}
