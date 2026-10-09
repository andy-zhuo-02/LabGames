// Celebration receipts are separate from scoring. A disconnected human still needs to clap.
export function updateApplause(game, members, previous, makeId) {
  const round = game?.history.at(-1);
  if (
    !game ||
    game.phase === "playing" ||
    round?.round !== game.round ||
    !round.flipId ||
    !members.some((member) => member.id === round.flipId)
  )
    return null;
  const same =
    previous?.round === round.round &&
    previous.playerId === round.flipId &&
    typeof previous.id === "string" &&
    Array.isArray(previous.acknowledgedIds);
  const acknowledged = new Set(same ? previous.acknowledgedIds : []);
  return {
    id: same ? previous.id : makeId(),
    round: round.round,
    playerId: round.flipId,
    acknowledgedIds: members
      .filter((member) => member.bot || acknowledged.has(member.id))
      .map((member) => member.id),
  };
}

export function applauseView(receipt, members) {
  if (!receipt) return null;
  const participants = members.map((member) => ({
    id: member.id,
    name: member.name,
    automatic: !!member.bot,
    applauded: receipt.acknowledgedIds.includes(member.id),
  }));
  return {
    ...receipt,
    participants,
    complete: participants.every((member) => member.applauded),
  };
}
