import { useEffect, useState, type FormEvent } from 'react';
import {
  Gem,
  Bot,
  ArrowRight,
  Plus,
  Users,
  Clock3,
  HelpCircle,
  Wifi,
  WifiOff,
  Crown,
  Check,
  Copy,
  Share2,
  LogOut,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useGame, type GameClient } from './useGame.js';
import { Dialog, Rules } from './components.js';
import type { RoomView } from '../shared/types.js';
import { Board } from './Board.js';
import { useWebMCP } from './useWebMCP.js';

export function App() {
  const client = useGame();
  useWebMCP(client);
  const [rules, setRules] = useState(false),
    [share, setShare] = useState(false);
  const { room, connection, error, setError } = client;
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark">
            <Gem size={25} />
          </span>
          <span>
            璀璨宝石<small>SPLENDOR</small>
          </span>
        </div>
        <div className="header-actions">
          <span className={`connection ${connection === 'connected' ? '' : 'disconnected'}`}>
            {connection === 'connected' ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>
              {
                {
                  connected: '局域网已连接',
                  connecting: '正在恢复连接',
                  offline: '连接已断开',
                  replaced: '座位已在其他页面打开',
                }[connection]
              }
            </span>
          </span>
          {room && (
            <button className="button subtle compact" onClick={() => setShare(true)}>
              <Share2 size={16} />
              <span>{room.code}</span>
            </button>
          )}
          <button
            className="icon-button"
            title="游戏规则"
            aria-label="游戏规则"
            onClick={() => setRules(true)}
          >
            <HelpCircle size={21} />
          </button>
        </div>
      </header>
      {connection !== 'connected' && (
        <div className="connection-banner" role="status">
          {connection === 'replaced'
            ? '请在最近打开的标签页继续，或刷新此页取回座位。'
            : room
              ? '正在连接主机。座位和已确认的操作已保存，连接恢复后可继续。'
              : '正在连接游戏主机，请稍候…'}
        </div>
      )}
      {!room ? (
        <Entrance client={client} />
      ) : room.status === 'waiting' ? (
        <WaitingRoom client={client} onShare={() => setShare(true)} />
      ) : (
        <Board client={client} />
      )}
      <footer className="site-footer">
        <span>璀璨宝石 · 基础版</span>
        <span>2–4 位玩家 · 同一网络，一起开局</span>
      </footer>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}>
            <X size={18} />
          </button>
        </div>
      )}
      {rules && <Rules onClose={() => setRules(false)} />}
      {share && room && <ShareRoom room={room} onClose={() => setShare(false)} />}
    </div>
  );
}
function Entrance({ client }: { client: GameClient }) {
  const initialCode = new URLSearchParams(window.location.search).get('room') ?? '';
  const [mode, setMode] = useState<'create' | 'join'>(initialCode ? 'join' : 'create');
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('splendor.nickname') ?? '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState(initialCode.toUpperCase());
  const disabled = client.busy || client.connection !== 'connected';
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      localStorage.setItem('splendor.nickname', name.trim());
    } catch {
      /* optional preference */
    }
    if (mode === 'create') await client.create(name.trim());
    else await client.join(name.trim(), code.trim());
  }
  return (
    <main className="entrance">
      <section className="welcome">
        <div className="eyebrow">
          <span /> THE GEM MERCHANTS
        </div>
        <h1>
          璀璨之间，
          <br />
          好局开启。
        </h1>
        <p className="welcome-copy">
          邀上好友，成为文艺复兴时代的宝石商人。
          <br />
          从第一枚宝石，到属于你的商业帝国。
        </p>
        <div className="game-meta">
          <span>
            <Users size={18} /> 2–4 人
          </span>
          <span>
            <Clock3 size={18} /> 约 30 分钟
          </span>
          <span>
            <Wifi size={18} /> 局域网联机
          </span>
        </div>
        <div className="welcome-rule">
          <span className="rule-number">15</span>
          <p>
            声望，开启最终角逐<small>收集宝石 · 购买卡牌 · 赢得贵族青睐</small>
          </p>
        </div>
      </section>
      <section className="entry-panel">
        <div className="entry-heading">
          <span className="eyebrow">READY TO PLAY</span>
          <h2>入座，开始一局</h2>
          <p>玩家只需浏览器，无需注册。</p>
        </div>
        <div className="segmented" role="group" aria-label="房间操作">
          <button
            aria-pressed={mode === 'create'}
            className={mode === 'create' ? 'active' : ''}
            onClick={() => setMode('create')}
          >
            <Plus size={17} />
            创建房间
          </button>
          <button
            aria-pressed={mode === 'join'}
            className={mode === 'join' ? 'active' : ''}
            onClick={() => setMode('join')}
          >
            <Users size={17} />
            加入房间
          </button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="nickname">你的昵称</label>
          <input
            id="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="朋友们怎么称呼你？"
            maxLength={16}
            required
            autoComplete="nickname"
          />
          {mode === 'join' && (
            <>
              <label htmlFor="room-code">房间码</label>
              <input
                id="room-code"
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="输入 6 位房间码"
                minLength={6}
                maxLength={6}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          <button
            className="button primary full"
            disabled={disabled || !name.trim() || (mode === 'join' && code.trim().length !== 6)}
            type="submit"
          >
            {client.busy ? '正在入座…' : mode === 'create' ? '创建一张新牌桌' : '加入好友的牌桌'}
            <ArrowRight size={18} />
          </button>
        </form>
        <div className="entry-note">
          <Wifi size={17} />
          <p>
            与好友连接同一 Wi-Fi 或局域网，
            <br />
            打开主机分享的地址即可加入。
          </p>
        </div>
      </section>
    </main>
  );
}
function WaitingRoom({ client, onShare }: { client: GameClient; onShare: () => void }) {
  const room = client.room!,
    me = room.seats.find((s) => s.id === room.selfId)!;
  const isHost = room.selfId === room.hostId,
    disabled = client.busy || client.connection !== 'connected';
  const canStart = room.seats.length >= 2 && room.seats.every((s) => s.ready && s.online);
  return (
    <main className="waiting-room">
      <div className="section-heading">
        <div>
          <div className="eyebrow">THE TABLE IS YOURS</div>
          <h1>等待好友入座</h1>
          <p>邀请好友或添加 AI，准备后即可开始。先手将随机决定。</p>
        </div>
        <button
          className="button subtle"
          disabled={disabled}
          onClick={() => void client.command({ type: 'leave' })}
        >
          <LogOut size={17} />
          离开房间
        </button>
      </div>
      <div className="waiting-layout">
        <section className="seats-grid">
          {Array.from({ length: 4 }, (_, i) => {
            const seat = room.seats[i];
            return (
              <article className={`seat-card ${seat ? '' : 'empty'}`} key={seat?.id ?? i}>
                <span className="seat-position">座位 {String(i + 1).padStart(2, '0')}</span>
                {seat ? (
                  <>
                    <div className={`avatar avatar-${i}`}>
                      {seat.bot ? <Bot size={28} /> : seat.name.slice(0, 1)}
                      {seat.id === room.hostId && (
                        <span className="host-crown">
                          <Crown size={14} />
                        </span>
                      )}
                    </div>
                    <h3>
                      {seat.name}
                      {seat.id === room.selfId && <small>你</small>}
                    </h3>
                    <span className={`seat-status ${seat.ready && seat.online ? 'ready' : ''}`}>
                      {!seat.online ? (
                        '暂时离线'
                      ) : seat.ready ? (
                        <>
                          <Check size={15} />
                          已准备
                        </>
                      ) : (
                        '等待准备'
                      )}
                    </span>
                    {isHost && seat.bot && (
                      <button
                        className="text-button remove-seat"
                        disabled={disabled}
                        onClick={() =>
                          void client.command({ type: 'removeBot', playerId: seat.id })
                        }
                      >
                        移除 AI
                      </button>
                    )}
                    {isHost && !seat.online && !seat.bot && (
                      <button
                        className="text-button remove-seat"
                        disabled={disabled}
                        onClick={() => void client.command({ type: 'kick', playerId: seat.id })}
                      >
                        移除离线玩家
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div className="empty-avatar">
                      <Plus size={27} />
                    </div>
                    <h3>虚位以待</h3>
                    <span className="seat-status">分享房间，邀请好友</span>
                  </>
                )}
              </article>
            );
          })}
        </section>
        <aside className="room-panel">
          <span className="eyebrow">INVITE YOUR FRIENDS</span>
          <h2>这局，等你</h2>
          <p>让好友打开邀请链接，或在同一主机页面输入房间码。</p>
          <div className="large-room-code">{room.code}</div>
          <button className="button subtle full" onClick={onShare}>
            <Share2 size={17} />
            分享链接与二维码
          </button>
          <div className="divider" />
          <div className="room-setting">
            <span>规则</span>
            <b>基础版 · 15 分</b>
          </div>
          <div className="room-setting">
            <span>已入座</span>
            <b>{room.seats.length} / 4 人</b>
          </div>
          {isHost && (
            <button
              className="button subtle full"
              disabled={disabled || room.seats.length >= 4}
              onClick={() => void client.command({ type: 'addBot' })}
            >
              <Bot size={18} />
              {room.seats.length >= 4 ? '牌桌已满' : '添加 AI 对手'}
            </button>
          )}
          {isHost && <p className="panel-hint">可添加 1～3 位 AI，单人也能开局</p>}
          <button
            className={`button ${me.ready ? 'subtle' : 'primary'} full`}
            disabled={disabled}
            onClick={() => void client.command({ type: 'ready', ready: !me.ready })}
          >
            {me.ready ? '取消准备' : '我准备好了'}
            <Check size={18} />
          </button>
          {isHost && (
            <button
              className="button primary full"
              disabled={disabled || !canStart}
              onClick={() => void client.command({ type: 'start' })}
            >
              开始对局
              <ArrowRight size={18} />
            </button>
          )}
          <p className="panel-hint">
            {isHost ? '至少 2 人，全部在线并准备后即可开始' : '准备好后，等待房主开始游戏'}
          </p>
        </aside>
      </div>
    </main>
  );
}
function ShareRoom({ room, onClose }: { room: RoomView; onClose: () => void }) {
  const [addresses, setAddresses] = useState<string[]>([]),
    [selected, setSelected] = useState(''),
    [qr, setQr] = useState(''),
    [copied, setCopied] = useState(false);
  const current = window.location.origin;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  useEffect(() => {
    let active = true;
    void fetch('/api/network')
      .then((r) => r.json())
      .then((data: { addresses: string[] }) => {
        if (!active) return;
        setAddresses(data.addresses);
        setSelected(local ? (data.addresses[0] ?? current) : current);
      })
      .catch(() => {
        if (active) setSelected(current);
      });
    return () => {
      active = false;
    };
  }, [current, local]);
  const url = selected ? `${selected}/?room=${room.code}` : '';
  useEffect(() => {
    let active = true;
    setQr('');
    if (url)
      void QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: '#172824', light: '#ffffff' },
      }).then((data) => {
        if (active) setQr(data);
      });
    return () => {
      active = false;
    };
  }, [url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      const input = document.getElementById('invite-url') as HTMLInputElement | null;
      input?.focus();
      input?.select();
      setCopied(false);
    }
  }
  return (
    <Dialog title="邀请好友入座" onClose={onClose}>
      <div className="share-content">
        {qr ? (
          <img className="qr" src={qr} alt="扫描二维码加入房间" width={224} height={224} />
        ) : (
          <div className="qr-placeholder">正在生成二维码…</div>
        )}
        <div className="eyebrow">房间码</div>
        <div className="large-room-code">{room.code}</div>
        <p>好友连接同一网络后，扫码或打开下方链接。</p>
        {addresses.length > 1 && (
          <label className="address-label">
            主机有多个网络，请选择好友可以访问的地址
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {[...new Set([selected, ...addresses])].filter(Boolean).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="copy-row">
          <input id="invite-url" aria-label="邀请链接" value={url} readOnly />
          <button className="button primary" disabled={!url} onClick={() => void copy()}>
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <p className="fine-print muted">如果复制不可用，可选中链接手动复制。主机需保持运行。</p>
      </div>
    </Dialog>
  );
}
