"""Text-only table rendering; card codes inside the engine stay unchanged."""

import os
import sys
import unicodedata


SUITS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}
TABLE_WIDTH = 72


def format_cards(cards, *, slots=0):
    rendered = [f"[{'10' if card[0] == 'T' else card[0]}{SUITS[card[1]]}]" for card in cards]
    rendered.extend("[   ]" for _ in range(max(0, slots - len(rendered))))
    return " ".join(rendered)


def display_width(text):
    return sum(
        0 if unicodedata.combining(char) else
        2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
        for char in text
    )


def centered(text, width):
    padding = max(0, width - display_width(text))
    return " " * (padding // 2) + text + " " * (padding - padding // 2)


def can_refresh():
    return sys.stdout.isatty() and os.environ.get("TERM", "") != "dumb"


def clear_screen():
    # Clear the visible screen, retaining the user's terminal scrollback.
    print("\033[2J\033[H", end="", flush=True)


def render_table(observation, seats, *, shown_hands=None):
    """Keep physical seats stable even as hand positions rotate or players bust."""
    seats = sorted(seats, key=lambda player: player.player_id)
    viewer_index = next(index for index, player in enumerate(seats) if player.player_id == observation.player_id)
    seats = seats[viewer_index:] + seats[:viewer_index]
    current = {player.player_id: player for player in observation.players}
    shown_hands = shown_hands or {}

    def seat_lines(seat):
        player = current.get(seat.player_id)
        if player is None:
            return (f"{seat.name} [已淘汰]", "筹码 0", "--")
        marker = "> " if player.player_id == observation.actor_id else ""
        title = f"{marker}{player.name} [{player.position}]"
        info = f"筹码 {player.stack} | 下注 {player.bet}"
        if observation.street == "finished":
            if player.stack == 0:
                info += " | 淘汰"
        elif not player.active:
            info += " | 弃牌"
        elif player.stack == 0:
            info += " | 全下"
        if seat.player_id == observation.player_id:
            cards = "你的底牌: " + format_cards(observation.hole_cards)
        elif seat.player_id in shown_hands:
            cards = format_cards(shown_hands[seat.player_id])
        else:
            cards = "未亮牌" if observation.street == "finished" else "[ ? ] [ ? ]"
        return title, info, cards

    lines = []
    opponents = seats[1:]
    if len(opponents) == 2:
        left, right = (seat_lines(seat) for seat in opponents)
        for first, second in zip(left, right):
            lines.append(centered(first, 34) + "    " + centered(second, 34))
    else:
        # Heads-up is centered across from the viewer. Larger custom tables
        # keep every opponent visible above the board in clockwise seat order.
        for opponent in opponents:
            lines.extend(centered(line, TABLE_WIDTH) for line in seat_lines(opponent))
    edge = "." + "-" * 56 + "."
    lines.append(centered(edge, TABLE_WIDTH))
    pot_label = "本手已结算" if observation.street == "finished" else f"底池 {observation.pot}"
    lines.append(centered("/" + centered(pot_label, 56) + "\\", TABLE_WIDTH))
    board = "公共牌: " + format_cards(observation.board, slots=5)
    lines.append(centered("|" + centered(board, 56) + "|", TABLE_WIDTH))
    lines.append(centered("\\" + "_" * 56 + "/", TABLE_WIDTH))
    lines.extend(centered(line, TABLE_WIDTH) for line in seat_lines(seats[0]))
    lines.append("BTN=庄家  SB=小盲  BB=大盲  > 当前行动  座位按顺时针排列")
    return "\n".join(line.rstrip() for line in lines)
