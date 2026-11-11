import { DateTime } from "luxon";

export function getAvailableDays(_master, timezone, horizonDays) {
  const today = DateTime.now().setZone(timezone).startOf("day");
  return Array.from({ length: horizonDays }, (_, offset) => today.plus({ days: offset }));
}

export function getAvailableSlots(master, dayISO, config, storage, ignoreBookingId = null) {
  const day = DateTime.fromISO(dayISO, { zone: config.timezone }).startOf("day");
  if (!day.isValid) return [];

  const now = DateTime.now().setZone(config.timezone);
  const duration = config.bookingDurationMinutes;
  const [startHour, startMinute] = String(master.dailyStart ?? "10:00").split(":").map(Number);
  const [endHour, endMinute] = String(master.dailyEnd ?? "20:00").split(":").map(Number);
  const shiftStart = day.set({ hour: startHour, minute: startMinute });
  const shiftEnd = day.set({ hour: endHour, minute: endMinute });
  const blocks = storage.getAvailabilityBlocks(master.id, dayISO);
  const slots = [];
  for (
    let start = shiftStart;
    start.plus({ minutes: duration }).toMillis() <= shiftEnd.toMillis();
    start = start.plus({ minutes: config.slotStepMinutes })
  ) {
    const end = start.plus({ minutes: duration });
    const startOfDay = start.hour * 60 + start.minute;
    const endOfDay = end.hour * 60 + end.minute;
    const isBlocked = blocks.some((block) => block.startMinute === null
      || (startOfDay < block.endMinute && endOfDay > block.startMinute));
    if (start.toMillis() > now.toMillis() && !isBlocked) slots.push({ start, end });
  }

  if (slots.length === 0) return [];
  const booked = storage.getBookedIntervals(
    master.id,
    shiftStart.toMillis(),
    shiftEnd.toMillis(),
    ignoreBookingId,
  );
  return slots.filter(({ start, end }) =>
    !booked.some((booking) => start.toMillis() < booking.ends_at && end.toMillis() > booking.starts_at),
  );
}
