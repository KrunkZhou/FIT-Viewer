import * as Popover from "@radix-ui/react-popover";
import { CalendarRange, CheckSquare, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { TimeRange } from "../model";
import { hasTimeRange } from "../document/time-range";
import {
  dateFilterRange,
  dateInputValue,
  dateLabel,
  selectedDateRange,
  selectedDates,
  usesDateList,
} from "./date-filter";
import { ControlTooltip } from "./ControlTooltip";
import { IconButton } from "./controls";

export function DateRangeFilter({
  value,
  onChange,
  availableDates = [],
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  availableDates?: string[];
}) {
  const [open, setOpen] = useState(false);
  const fromInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const list = usesDateList(availableDates);
  const filtered = hasTimeRange(value);
  const description = filtered
    ? value.intervals !== undefined
      ? `Date filter: ${value.intervals.length} dates selected (local time)`
      : `Date filter: ${dateInputValue(value.start) || "Any start"} to ${dateInputValue(value.end) || "Any end"} (local time)`
    : "Filter Charts and Map by date";
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError("");
          setChecked(selectedDates(availableDates, value));
        }
      }}
    >
      <ControlTooltip content={description}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="viewer-icon-button viewer-date-filter-button"
            aria-label="Filter by date"
            data-active={filtered}
          >
            <CalendarRange size={18} />
            {filtered && <span className="viewer-date-filter-dot" />}
          </button>
        </Popover.Trigger>
      </ControlTooltip>
      <Popover.Portal>
        <Popover.Content
          className="viewer-date-filter-popup"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={list ? "Select dates" : "Date range"}
          onOpenAutoFocus={(event) => {
            if (!list) {
              event.preventDefault();
              fromInput.current?.focus();
            }
          }}
        >
          <div className="viewer-app-info-title">
            <h3>{list ? "Select dates" : "Date range"}</h3>
            <Popover.Close asChild>
              <IconButton title="Close date filter">
                <X size={16} />
              </IconButton>
            </Popover.Close>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                if (list) {
                  onChange(
                    checked.length === availableDates.length
                      ? {}
                      : selectedDateRange(checked),
                  );
                  setOpen(false);
                  return;
                }
                const fields = new FormData(event.currentTarget);
                onChange(
                  dateFilterRange(
                    String(fields.get("from") ?? ""),
                    String(fields.get("through") ?? ""),
                  ),
                );
                setOpen(false);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            {list ? (
              <>
                <div className="viewer-date-select-actions">
                  <IconButton
                    title="Select all dates"
                    tooltip="Select all dates"
                    onClick={() => setChecked([...availableDates])}
                  >
                    <CheckSquare size={18} />
                  </IconButton>
                  <IconButton
                    title="Deselect all dates"
                    tooltip="Deselect all dates"
                    onClick={() => setChecked([])}
                  >
                    <Square size={18} />
                  </IconButton>
                  <span className="viewer-muted">
                    {checked.length} / {availableDates.length}
                  </span>
                </div>
                <div
                  className="viewer-date-options"
                  role="group"
                  aria-label="Available dates"
                >
                  {availableDates.map((date) => (
                    <label key={date}>
                      <input
                        type="checkbox"
                        aria-label={date}
                        checked={checked.includes(date)}
                        onChange={(event) =>
                          setChecked((previous) =>
                            event.target.checked
                              ? [...previous, date]
                              : previous.filter((item) => item !== date),
                          )
                        }
                      />
                      <span>{dateLabel(date)}</span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label>
                  From
                  <input
                    type="date"
                    name="from"
                    ref={fromInput}
                    aria-label="From date"
                    defaultValue={dateInputValue(value.start)}
                  />
                </label>
                <label>
                  Through
                  <input
                    type="date"
                    name="through"
                    aria-label="Through date"
                    defaultValue={dateInputValue(value.end)}
                  />
                </label>
              </>
            )}
            <small className="viewer-muted">Local time</small>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="viewer-date-filter-actions">
              <button
                type="button"
                className="viewer-command"
                onClick={() => {
                  onChange({});
                  setOpen(false);
                }}
              >
                Clear
              </button>
              <button type="submit" className="viewer-command">
                Apply
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
