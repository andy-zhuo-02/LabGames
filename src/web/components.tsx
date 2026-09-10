import { useEffect, useRef, useState, type ReactNode } from 'react';
import cardArt from './card-art.json';
import { X, Crown } from 'lucide-react';
import {
  COLORS,
  COLOR_NAMES,
  type Token,
  type Card,
  type Gems,
  type Tokens,
} from '../shared/types.js';

const gemArt: Record<Token, string> = {
  white: '/art/gems/diamond.png',
  blue: '/art/gems/sapphire.png',
  green: '/art/gems/emerald.png',
  red: '/art/gems/ruby.png',
  black: '/art/gems/onyx.png',
  gold: '/art/gems/gold.png',
};
export function GemIcon({ color, size = 19 }: { color: Token; size?: number }) {
  return (
    <img
      className={`gem-symbol ${color}`}
      src={gemArt[color]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
export function GemCount({
  color,
  count,
  muted = false,
}: {
  color: Token;
  count: number;
  muted?: boolean;
}) {
  return (
    <span
      className={`gem-count ${color} ${muted ? 'muted' : ''}`}
      title={`${COLOR_NAMES[color]} ${count}`}
      aria-label={`${COLOR_NAMES[color]} ${count}`}
    >
      <GemIcon color={color} size={16} />
      <b>{count}</b>
    </span>
  );
}
export function Costs({ cost }: { cost: Gems | Tokens }) {
  return (
    <div className="costs">
      {COLORS.filter((c) => cost[c] > 0).map((c) => (
        <GemCount key={c} color={c} count={cost[c]} />
      ))}
    </div>
  );
}
export function DevelopmentCard({
  card,
  onClick,
  affordable,
  selected,
}: {
  card: Card;
  onClick?: () => void;
  affordable?: boolean;
  selected?: boolean;
}) {
  const imagePath = (cardArt as Record<string, string>)[card.id];
  const [artLoaded, setArtLoaded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  return (
    <button
      type="button"
      className={`development-card ${card.bonus} ${affordable ? 'affordable' : ''} ${selected ? 'selected' : ''} ${artLoaded ? 'has-art' : ''}`}
      onClick={onClick}
      aria-label={`${card.tier} 级${COLOR_NAMES[card.bonus]}卡牌，${card.points} 分，费用 ${COLORS.filter(
        (c) => card.cost[c],
      )
        .map((c) => `${COLOR_NAMES[c]} ${card.cost[c]}`)
        .join('、')}`}
    >
      {imagePath && !artFailed && (
        <img
          className="original-card-art"
          src={imagePath}
          alt=""
          loading="lazy"
          decoding="async"
          width={630}
          height={880}
          onLoad={() => setArtLoaded(true)}
          onError={() => {
            setArtFailed(true);
            setArtLoaded(false);
          }}
        />
      )}
      <div className="card-head">
        <span className="prestige">{card.points || ''}</span>
        <span className="card-bonus">
          <GemIcon color={card.bonus} size={36} />
        </span>
      </div>
      <div className="card-center">
        <GemIcon color={card.bonus} size={48} />
      </div>
      <div className="card-foot">
        <Costs cost={card.cost} />
      </div>
      {affordable && <span className="afford-dot" title="可以购买" />}
    </button>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Rules({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="一局璀璨宝石" onClose={onClose}>
      <div className="rules-intro">
        <Crown size={30} />
        <p>积累宝石，发展产业，赢得贵族的青睐。</p>
      </div>
      <ol className="rules-list">
        <li>
          <b>每回合，选择一项行动</b>
          <p>
            拿三种不同颜色的宝石；拿两枚同色宝石（该色库存至少 4
            枚）；预留一张卡牌；或购买一张卡牌。不同色不足三种时，拿所有可用颜色各一枚。
          </p>
        </li>
        <li>
          <b>发展卡让下一次购买更便宜</b>
          <p>每张已购卡提供一个永久颜色折扣。黄金可以替代任意颜色，购买时可自行调整支付方案。</p>
        </li>
        <li>
          <b>为下一步做准备</b>
          <p>
            最多预留 3 张卡牌；预留时如有黄金则获得 1 枚。回合结束最多持有 10
            枚宝石，黄金也计入上限。
          </p>
        </li>
        <li>
          <b>吸引贵族，争夺声望</b>
          <p>永久折扣达到贵族要求后自动获得贵族，每回合最多一位；多位符合时自行选择。</p>
        </li>
        <li>
          <b>15 分触发最后一轮</b>
          <p>所有玩家完成相同回合数后比较总分。同分时，购买卡牌更少者获胜；仍然相同则共享胜利。</p>
        </li>
      </ol>
      <p className="muted fine-print">
        本局使用基础版规则。先手随机决定；仅在所有正常行动均不可执行时允许跳过。
      </p>
    </Dialog>
  );
}
