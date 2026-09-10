import { useEffect, useState } from 'react';
import {
  Crown,
  Bot,
  ArrowRight,
  Check,
  Minus,
  Plus,
  Layers3,
  Flag,
  Trophy,
  BookOpen,
  RotateCcw,
  LogOut,
  Coins,
  Users,
} from 'lucide-react';
import {
  COLORS,
  TOKENS,
  COLOR_NAMES,
  emptyTokens,
  totalTokens,
  bonuses,
  score,
  price,
  suggestedPayment,
  canAfford,
  type Card,
  type Tier,
  type Tokens,
  type PlayerView,
  type Action,
} from '../shared/types.js';
import { canPass } from '../engine/game.js';
import type { GameClient } from './useGame.js';
import { Costs, DevelopmentCard, Dialog, GemCount, GemIcon } from './components.js';

type Selection = { kind: 'card'; card: Card } | { kind: 'deck'; tier: Tier };
export function Board({ client }: { client: GameClient }) {
  const room = client.room!,
    game = room.game!,
    me = game.players.find((p) => p.id === room.selfId)!;
  const current = game.players[game.currentPlayer];
  const myTurn = current.id === room.selfId && room.status === 'playing';
  const disabled = client.busy || client.connection !== 'connected';
  const canAct = myTurn && game.phase === 'action' && !disabled;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewCollection, setViewCollection] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(room.status === 'finished');
  useEffect(() => {
    if (room.status === 'finished') setShowResult(true);
  }, [room.status]);
  const discount = bonuses(me);
  const eligible = game.nobles.filter((n) => COLORS.every((c) => discount[c] >= n.cost[c]));
  async function act(action: Action) {
    const result = await client.command({ type: 'action', action });
    if (result?.ok) setSelection(null);
    return result;
  }
  const turnText =
    room.status === 'finished'
      ? '本局已结束'
      : myTurn
        ? game.phase === 'return'
          ? '归还多余的宝石'
          : game.phase === 'noble'
            ? '选择一位贵族'
            : '轮到你了'
        : `等待 ${current.name}`;
  const collectionPlayer = game.players.find((p) => p.id === viewCollection);
  return (
    <main className="game-page">
      <div className="game-topline">
        <div className="round-badge">
          <span>ROUND</span>
          <b>{String(game.round).padStart(2, '0')}</b>
        </div>
        <div className="turn-indicator">
          <span className={`turn-dot ${myTurn ? 'yours' : ''}`} />
          <div>
            <h1>{turnText}</h1>
            <p>
              {room.status === 'finished'
                ? '可以查看棋盘，或回到房间再来一局'
                : myTurn
                  ? game.phase === 'return'
                    ? `持有 ${totalTokens(me.tokens)} 枚，请归还至 10 枚`
                    : game.phase === 'noble'
                      ? '点击下方高亮的贵族，获得 3 点声望'
                      : '拿取宝石、预留卡牌，或发展你的产业'
                  : '趁现在，规划你的下一步'}
            </p>
          </div>
        </div>
        <div className="topline-actions">
          {game.finalRound && (
            <span className="final-round">
              <Flag size={14} />
              最后一轮
            </span>
          )}
          {room.status === 'finished' ? (
            <button className="button subtle compact" onClick={() => setShowResult(true)}>
              <Trophy size={16} />
              查看结算
            </button>
          ) : (
            room.hostId === room.selfId && (
              <button
                className="icon-button"
                title="结束本局"
                aria-label="结束本局"
                disabled={disabled}
                onClick={() => setConfirmEnd(true)}
              >
                <Flag size={18} />
              </button>
            )
          )}
        </div>
      </div>
      <div className="game-layout">
        <div className="table-surface">
          <section className="nobles-section">
            <div className="subheading">
              <h2>
                <Crown size={16} />
                贵族议会
              </h2>
              <span>满足条件，赢得 3 点声望</span>
            </div>
            <div className="nobles-row">
              {game.nobles.map((noble, i) => {
                const available =
                  myTurn && game.phase === 'noble' && eligible.some((n) => n.id === noble.id);
                return (
                  <button
                    key={noble.id}
                    className={`noble-card ${available ? 'eligible' : ''}`}
                    disabled={!available || disabled}
                    aria-label={`贵族 ${i + 1}，要求 ${COLORS.filter((c) => noble.cost[c])
                      .map((c) => `${COLOR_NAMES[c]}折扣 ${noble.cost[c]}`)
                      .join('、')}${available ? '，点击选择' : ''}`}
                    onClick={() => void act({ type: 'noble', nobleId: noble.id })}
                  >
                    <div className="noble-emblem">
                      <Crown size={25} />
                      <span>3</span>
                    </div>
                    <Costs cost={noble.cost} />
                    {available && (
                      <span className="noble-choose">
                        选择贵族
                        <Check size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
              {!game.nobles.length && <div className="empty-nobles">所有贵族都已找到了赞助人</div>}
            </div>
          </section>
          <section className="market-section">
            <div className="subheading">
              <h2>
                <Layers3 size={16} />
                发展卡市场
              </h2>
              <span>
                <i className="legend-dot" />
                金色边框表示可以购买
              </span>
            </div>
            {([3, 2, 1] as Tier[]).map((tier) => (
              <div className="market-row" key={tier}>
                <button
                  className={`deck deck-${tier}`}
                  disabled={game.deckCounts[tier] === 0}
                  onClick={() => setSelection({ kind: 'deck', tier })}
                  aria-label={`预留 ${tier} 级牌堆顶牌，剩余 ${game.deckCounts[tier]} 张`}
                >
                  <span className="deck-rank">{'ⅠⅡⅢ'[tier - 1]}</span>
                  <span className="deck-symbol">
                    <GemIcon color="gold" size={29} />
                  </span>
                  <span className="deck-count">
                    {game.deckCounts[tier]}
                    <small>张</small>
                  </span>
                </button>
                {game.market[tier].map((card, index) =>
                  card ? (
                    <DevelopmentCard
                      key={card.id}
                      card={card}
                      affordable={canAfford(me, card)}
                      onClick={() => setSelection({ kind: 'card', card })}
                    />
                  ) : (
                    <div className="empty-card" key={`empty-${index}`}>
                      牌堆已空
                    </div>
                  ),
                )}
              </div>
            ))}
          </section>
          {game.phase === 'return' && myTurn ? (
            <ReturnTokens
              tokens={me.tokens}
              disabled={disabled}
              onReturn={(tokens) => act({ type: 'return', tokens })}
            />
          ) : (
            <Bank
              bank={game.bank}
              canAct={canAct}
              phaseKey={`${game.round}:${game.currentPlayer}:${game.phase}`}
              onTake={(colors) => act({ type: 'take', colors })}
            />
          )}
          {canAct && canPass(game, me) && (
            <button className="button subtle full" onClick={() => void act({ type: 'pass' })}>
              当前无可执行行动，跳过回合
              <ArrowRight size={17} />
            </button>
          )}
          <section className="your-table">
            <div className="subheading">
              <h2>你的宝石与产业</h2>
              <button className="text-button" onClick={() => setViewCollection(me.id)}>
                <BookOpen size={14} />
                已购 {me.purchased.length} 张
              </button>
            </div>
            <div className="your-resources">
              <div className="your-score">
                <Trophy size={18} />
                <b>{score(me)}</b>
                <span>声望</span>
              </div>
              <div className="resource-table">
                <div className="resource-labels">
                  <span>持有宝石</span>
                  <span>永久折扣</span>
                </div>
                {TOKENS.map((c) => (
                  <div className={`resource-column ${c}`} key={c}>
                    <GemIcon color={c} size={18} />
                    <b>{me.tokens[c]}</b>
                    <span>{c === 'gold' ? '—' : discount[c]}</span>
                  </div>
                ))}
              </div>
              <span className={`token-limit ${totalTokens(me.tokens) > 10 ? 'over-limit' : ''}`}>
                {totalTokens(me.tokens)}
                <small>/ 10 枚</small>
              </span>
            </div>
            <div className="reserved-heading">
              <span>
                预留卡牌 <b>{me.reserved.length} / 3</b>
              </span>
              <small>仅你可见</small>
            </div>
            <div className="reserved-row">
              {Array.from({ length: 3 }, (_, i) => {
                const card = me.reserved[i];
                return card ? (
                  <button
                    className={`reserved-card ${card.bonus} ${canAfford(me, card) ? 'affordable' : ''}`}
                    onClick={() => setSelection({ kind: 'card', card })}
                    key={card.id}
                  >
                    <GemIcon color={card.bonus} size={22} />
                    <div>
                      <span>
                        {COLOR_NAMES[card.bonus]} · {card.points} 分
                      </span>
                      <Costs cost={card.cost} />
                    </div>
                    <ArrowRight size={15} />
                  </button>
                ) : (
                  <div className="reserved-empty" key={i}>
                    <Plus size={15} />
                    预留位置
                  </div>
                );
              })}
            </div>
          </section>
        </div>
        <aside className="game-sidebar">
          <section>
            <div className="subheading">
              <h2>
                <UsersIcon />
                桌上玩家
              </h2>
              <span>{game.players.length} 人</span>
            </div>
            <div className="players-list">
              {game.players.map((player, i) => (
                <PlayerPanel
                  key={player.id}
                  player={player}
                  index={i}
                  self={player.id === room.selfId}
                  current={current.id === player.id && room.status === 'playing'}
                  online={!!room.seats.find((s) => s.id === player.id)?.online}
                  bot={!!room.seats.find((s) => s.id === player.id)?.bot}
                  onInspect={() => setViewCollection(player.id)}
                />
              ))}
            </div>
          </section>
          <section className="history">
            <div className="subheading">
              <h2>对局记录</h2>
              <span>最新在上</span>
            </div>
            <ol aria-live="polite" aria-relevant="additions">
              {[...game.log].reverse().map((entry, i) => (
                <li key={entry.id} className={i === 0 ? 'latest' : ''}>
                  <span className="log-dot" />
                  <p>{entry.text}</p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
      {selection?.kind === 'card' && (
        <CardAction
          key={selection.card.id}
          card={selection.card}
          player={me}
          isReserved={me.reserved.some((c) => c?.id === selection.card.id)}
          canAct={canAct}
          busy={disabled}
          phase={game.phase}
          onClose={() => setSelection(null)}
          onAction={act}
        />
      )}
      {selection?.kind === 'deck' && (
        <Dialog title={`预留 ${selection.tier} 级牌堆顶牌`} onClose={() => setSelection(null)}>
          <div className="blind-reserve">
            <Layers3 size={48} />
            <p>抽取一张未知的卡牌，留待以后购买。</p>
            <span>{game.bank.gold ? '同时获得 1 枚黄金' : '黄金已耗尽，仍可预留卡牌'}</span>
          </div>
          <button
            className="button primary full"
            disabled={!canAct || me.reserved.length >= 3}
            onClick={() => void act({ type: 'reserveDeck', tier: selection.tier })}
          >
            {me.reserved.length >= 3 ? '预留位置已满' : '确认预留'}
            <Check size={18} />
          </button>
          {!canAct && <p className="dialog-hint">请在你的主行动阶段操作</p>}
        </Dialog>
      )}
      {confirmEnd && (
        <Dialog title="结束当前对局？" onClose={() => setConfirmEnd(false)}>
          <p className="dialog-copy">
            所有玩家的本局游戏都会结束，不判定胜负。之后可以回到房间重新准备。
          </p>
          <div className="dialog-actions">
            <button className="button subtle" onClick={() => setConfirmEnd(false)}>
              继续游戏
            </button>
            <button
              className="button danger"
              disabled={disabled}
              onClick={async () => {
                const reply = await client.command({ type: 'end' });
                if (reply?.ok) setConfirmEnd(false);
              }}
            >
              结束本局
            </button>
          </div>
        </Dialog>
      )}
      {collectionPlayer && (
        <Dialog
          title={`${collectionPlayer.name} 的产业`}
          onClose={() => setViewCollection(null)}
          wide
        >
          <p className="collection-summary">
            {collectionPlayer.purchased.length} 张发展卡 · {collectionPlayer.nobles.length} 位贵族 ·{' '}
            {score(collectionPlayer)} 点声望
          </p>
          {collectionPlayer.purchased.length ? (
            <div className="collection-grid">
              {collectionPlayer.purchased.map((c) => (
                <DevelopmentCard key={c.id} card={c} />
              ))}
            </div>
          ) : (
            <p className="empty-collection">还没有购买发展卡</p>
          )}
          {collectionPlayer.nobles.length > 0 && (
            <div className="collection-nobles">
              {collectionPlayer.nobles.map((n) => (
                <div className="noble-card" key={n.id}>
                  <div className="noble-emblem">
                    <Crown size={22} />
                    <span>3</span>
                  </div>
                  <Costs cost={n.cost} />
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
      {showResult && room.status === 'finished' && (
        <Dialog title="本局结算" onClose={() => setShowResult(false)}>
          <div className="result-banner">
            <Trophy size={46} />
            <h3>
              {game.winners.length
                ? `${game.players
                    .filter((p) => game.winners.includes(p.id))
                    .map((p) => p.name)
                    .join('、')} 获胜`
                : '本局已由房主结束'}
            </h3>
            <p>
              {game.winners.length > 1
                ? '声望与发展卡数量相同，共享胜利'
                : game.winners.length
                  ? '感谢各位商人的精彩对局'
                  : '可以重新准备，开启下一局'}
            </p>
          </div>
          <div className="scoreboard">
            {[...game.players]
              .sort((a, b) => score(b) - score(a) || a.purchased.length - b.purchased.length)
              .map((p) => (
                <div key={p.id} className={game.winners.includes(p.id) ? 'winner' : ''}>
                  <span>
                    {game.winners.includes(p.id) && <Crown size={16} />}
                    {p.name}
                  </span>
                  <small>{p.purchased.length} 张发展卡</small>
                  <b>
                    {score(p)}
                    <small> 分</small>
                  </b>
                </div>
              ))}
          </div>
          {room.hostId === room.selfId ? (
            <button
              className="button primary full"
              disabled={disabled}
              onClick={() => void client.command({ type: 'rematch' })}
            >
              <RotateCcw size={17} />
              回到房间，再来一局
            </button>
          ) : (
            <p className="dialog-hint">等待房主开启下一局</p>
          )}
          <button
            className="button subtle full"
            disabled={disabled}
            onClick={() => void client.command({ type: 'leave' })}
          >
            <LogOut size={16} />
            离开房间
          </button>
        </Dialog>
      )}
    </main>
  );
}
function UsersIcon() {
  return <Users size={16} />;
}
function PlayerPanel({
  player,
  index,
  self,
  current,
  online,
  bot,
  onInspect,
}: {
  player: PlayerView;
  index: number;
  self: boolean;
  current: boolean;
  online: boolean;
  bot: boolean;
  onInspect: () => void;
}) {
  const discount = bonuses(player);
  return (
    <article className={`player-panel ${current ? 'current' : ''}`}>
      <div className="player-heading">
        <div className={`avatar small-avatar avatar-${index}`}>
          {bot ? <Bot size={21} /> : player.name.slice(0, 1)}
        </div>
        <div className="player-name">
          <b>
            {player.name}
            {self && <small>你</small>}
          </b>
          <span>
            {current
              ? bot
                ? 'AI 正在思考'
                : '正在行动'
              : !online
                ? '暂时离线'
                : index === 0
                  ? '本局先手'
                  : `${player.purchased.length} 张产业`}
          </span>
        </div>
        <div className="player-score">
          {score(player)}
          <small>分</small>
        </div>
      </div>
      <div className="player-gems">
        <div className="mini-labels">
          <span>宝石</span>
          <span>折扣</span>
        </div>
        {TOKENS.map((c) => (
          <div className={`mini-resource ${c}`} key={c}>
            <GemIcon color={c} size={14} />
            <b>{player.tokens[c]}</b>
            <span>{c === 'gold' ? '—' : discount[c]}</span>
          </div>
        ))}
      </div>
      <div className="player-foot">
        <span>
          <Layers3 size={13} />
          预留 {player.reserved.length} / 3
        </span>
        <span>
          <Crown size={13} />
          {player.nobles.length}
        </span>
        <button className="text-button" onClick={onInspect}>
          查看产业
          <ArrowRight size={12} />
        </button>
      </div>
    </article>
  );
}
function Bank({
  bank,
  canAct,
  phaseKey,
  onTake,
}: {
  bank: Tokens;
  canAct: boolean;
  phaseKey: string;
  onTake: (colors: (typeof COLORS)[number][]) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'different' | 'same'>('different');
  const [chosen, setChosen] = useState<(typeof COLORS)[number][]>([]);
  useEffect(() => setChosen([]), [phaseKey]);
  const required = Math.min(3, COLORS.filter((c) => bank[c] > 0).length);
  const valid =
    mode === 'same'
      ? chosen.length === 1 && bank[chosen[0]] >= 4
      : chosen.length === required && required > 0 && chosen.every((c) => bank[c] > 0);
  function toggle(color: (typeof COLORS)[number]) {
    if (mode === 'same') setChosen(chosen[0] === color ? [] : [color]);
    else
      setChosen(
        chosen.includes(color)
          ? chosen.filter((c) => c !== color)
          : chosen.length < required
            ? [...chosen, color]
            : [color],
      );
  }
  return (
    <section className="bank-section">
      <div className="subheading">
        <h2>
          <Coins size={16} />
          宝石银行
        </h2>
        <span>黄金通过预留获得</span>
      </div>
      <div className="bank-pool">
        {TOKENS.map((c) => (
          <button
            key={c}
            className={`bank-token ${c} ${chosen.includes(c as (typeof COLORS)[number]) ? 'chosen' : ''}`}
            disabled={!canAct || c === 'gold' || bank[c] === 0 || (mode === 'same' && bank[c] < 4)}
            onClick={() => c !== 'gold' && toggle(c)}
            aria-label={`${COLOR_NAMES[c]}，库存 ${bank[c]} 枚${c === 'gold' ? '，不可直接拿取' : ''}`}
            aria-pressed={c !== 'gold' && chosen.includes(c)}
          >
            <span className="token-disc">
              <GemIcon color={c} size={27} />
              {chosen.includes(c as (typeof COLORS)[number]) && (
                <span className="token-selected">{mode === 'same' ? 2 : 1}</span>
              )}
            </span>
            <span className="token-name">{COLOR_NAMES[c]}</span>
            <b>{bank[c]}</b>
          </button>
        ))}
      </div>
      <div className="bank-actions">
        <div className="take-modes" role="group" aria-label="拿取方式">
          <button
            aria-pressed={mode === 'different'}
            className={mode === 'different' ? 'active' : ''}
            onClick={() => {
              setMode('different');
              setChosen([]);
            }}
          >
            三种不同
          </button>
          <button
            aria-pressed={mode === 'same'}
            className={mode === 'same' ? 'active' : ''}
            onClick={() => {
              setMode('same');
              setChosen([]);
            }}
          >
            两枚同色
          </button>
        </div>
        <button
          className="button primary compact"
          disabled={!canAct || !valid}
          onClick={async () => {
            await onTake(mode === 'same' ? [chosen[0], chosen[0]] : chosen);
            setChosen([]);
          }}
        >
          拿取{chosen.length ? ` ${mode === 'same' ? 2 : chosen.length} 枚` : '宝石'}
          <Check size={16} />
        </button>
      </div>
    </section>
  );
}
function ReturnTokens({
  tokens,
  disabled,
  onReturn,
}: {
  tokens: Tokens;
  disabled: boolean;
  onReturn: (tokens: Tokens) => Promise<unknown>;
}) {
  const [returned, setReturned] = useState(emptyTokens);
  const count = totalTokens(tokens) - 10;
  return (
    <section className="return-panel">
      <div className="subheading">
        <h2>选择归还的宝石</h2>
        <span>
          已选择 {totalTokens(returned)} / {count} 枚
        </span>
      </div>
      <div className="return-pool">
        {TOKENS.map((c) => (
          <div className={`return-token ${c}`} key={c}>
            <GemIcon color={c} size={24} />
            <span>{COLOR_NAMES[c]}</span>
            <small>持有 {tokens[c]}</small>
            <div className="stepper">
              <button
                aria-label={`减少归还${COLOR_NAMES[c]}`}
                disabled={disabled || !returned[c]}
                onClick={() => setReturned({ ...returned, [c]: returned[c] - 1 })}
              >
                <Minus size={14} />
              </button>
              <b>{returned[c]}</b>
              <button
                aria-label={`增加归还${COLOR_NAMES[c]}`}
                disabled={disabled || returned[c] >= tokens[c] || totalTokens(returned) >= count}
                onClick={() => setReturned({ ...returned, [c]: returned[c] + 1 })}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        className="button primary full"
        disabled={disabled || totalTokens(returned) !== count}
        onClick={() => void onReturn(returned)}
      >
        确认归还 {count} 枚<Check size={17} />
      </button>
    </section>
  );
}
function CardAction({
  card,
  player,
  isReserved,
  canAct,
  busy,
  phase,
  onClose,
  onAction,
}: {
  card: Card;
  player: PlayerView;
  isReserved: boolean;
  canAct: boolean;
  busy: boolean;
  phase: string;
  onClose: () => void;
  onAction: (action: Action) => Promise<unknown>;
}) {
  const cost = price(player, card);
  const [payment, setPayment] = useState(() => suggestedPayment(player, card));
  const gold = COLORS.reduce((sum, c) => sum + cost[c] - payment[c], 0);
  const valid =
    gold <= player.tokens.gold &&
    COLORS.every((c) => payment[c] <= player.tokens[c] && payment[c] <= cost[c]);
  useEffect(
    () => setPayment(suggestedPayment(player, card)),
    [player.tokens, player.purchased, card],
  );
  return (
    <Dialog
      title={isReserved ? '购买预留卡牌' : `${COLOR_NAMES[card.bonus]} · 发展卡`}
      onClose={onClose}
    >
      <div className="card-detail">
        <DevelopmentCard card={card} />
        <div>
          <span className={`detail-bonus ${card.bonus}`}>
            <GemIcon color={card.bonus} size={23} />
            永久折扣 +1
          </span>
          <h3>{card.points} 点声望</h3>
          <p>
            {card.tier} 级发展卡{isReserved ? ' · 已预留' : ''}
          </p>
          <span className="muted fine-print">购买后，未来的同色费用减少 1。</span>
        </div>
      </div>
      <div className="payment-heading">
        <h3>支付方案</h3>
        <span>已扣除永久折扣</span>
      </div>
      {COLORS.filter((c) => cost[c] > 0).length === 0 ? (
        <p className="free-purchase">你的产业已覆盖全部费用，可以免费购买。</p>
      ) : (
        <div className="payment-list">
          {COLORS.filter((c) => cost[c] > 0).map((c) => (
            <div className="payment-row" key={c}>
              <span className={`gem-count ${c}`}>
                <GemIcon color={c} />
                {COLOR_NAMES[c]}
                <small>需 {cost[c]}</small>
              </span>
              <div className="stepper">
                <button
                  aria-label={`少用一枚${COLOR_NAMES[c]}，改用黄金`}
                  disabled={busy || payment[c] === 0}
                  onClick={() => setPayment({ ...payment, [c]: payment[c] - 1 })}
                >
                  <Minus size={14} />
                </button>
                <b>{payment[c]}</b>
                <button
                  aria-label={`多用一枚${COLOR_NAMES[c]}`}
                  disabled={busy || payment[c] >= Math.min(cost[c], player.tokens[c])}
                  onClick={() => setPayment({ ...payment, [c]: payment[c] + 1 })}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={`gold-payment ${valid ? '' : 'insufficient'}`}>
        <GemCount color="gold" count={gold} />
        <span>
          {valid
            ? `使用黄金替代 · 持有 ${player.tokens.gold} 枚`
            : `黄金不足 · 持有 ${player.tokens.gold} 枚`}
        </span>
      </div>
      <button
        className="button primary full"
        disabled={!canAct || !valid || busy}
        onClick={() =>
          void onAction({ type: 'buy', cardId: card.id, payment: { ...payment, gold } })
        }
      >
        {valid ? '确认购买' : '宝石不足'}
        <Check size={17} />
      </button>
      {!isReserved && (
        <button
          className="button subtle full"
          disabled={!canAct || player.reserved.length >= 3 || busy}
          onClick={() => void onAction({ type: 'reserve', cardId: card.id })}
        >
          <Layers3 size={17} />
          {player.reserved.length >= 3 ? '预留位置已满' : '先预留这张卡牌'}
        </button>
      )}
      {!canAct && (
        <p className="dialog-hint">
          {phase === 'return'
            ? '请先归还多余的宝石'
            : phase === 'noble'
              ? '请先选择贵族'
              : '请在你的主行动阶段操作'}
        </p>
      )}
    </Dialog>
  );
}
