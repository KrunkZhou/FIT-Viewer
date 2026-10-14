import * as Popover from "@radix-ui/react-popover";
import {
  ChartNoAxesColumnIncreasing,
  Check,
  ListPlus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ChartDetail, ChartQuery } from "../model";
import { ControlTooltip } from "./ControlTooltip";
import { IconButton } from "./controls";

type ValueBounds = NonNullable<ChartQuery["filter"]>;

export function parseReferenceValues(input: string): number[] {
  const values = input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("Enter finite numbers separated by commas.");
  return values;
}

export function parseValueBounds(
  minimum: string,
  maximum: string,
): ValueBounds {
  const filter: ValueBounds = {};
  if (minimum.trim()) filter.min = Number(minimum);
  if (maximum.trim()) filter.max = Number(maximum);
  if (
    [filter.min, filter.max].some(
      (value) => value !== undefined && !Number.isFinite(value),
    )
  )
    throw new Error("Enter finite minimum and maximum values.");
  if (
    filter.min !== undefined &&
    filter.max !== undefined &&
    filter.min > filter.max
  )
    throw new Error("Minimum must not exceed maximum.");
  return filter;
}

export function ReferenceValuesButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError("");
      }}
    >
      <ControlTooltip content="Add horizontal reference lines to every chart. Enter values separated by commas.">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="viewer-command viewer-chart-setting-button"
            data-active={parseReferenceValues(value).length > 0}
          >
            <ListPlus size={17} aria-hidden="true" /> Reference values
          </button>
        </Popover.Trigger>
      </ControlTooltip>
      <Popover.Portal>
        <Popover.Content
          className="viewer-chart-settings-popup"
          aria-label="Reference values"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
        >
          <div className="viewer-app-info-title">
            <h3>Reference values</h3>
            <Popover.Close asChild>
              <IconButton
                title="Close reference values"
                tooltip="Close without applying changes"
              >
                <X size={16} />
              </IconButton>
            </Popover.Close>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input = String(
                new FormData(event.currentTarget).get("references") ?? "",
              );
              try {
                parseReferenceValues(input);
                onChange(input.trim());
                setOpen(false);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            <label>
              Values
              <input
                ref={input}
                name="references"
                aria-label="Reference values"
                defaultValue={value}
                placeholder="0, 100, 200"
                autoComplete="off"
                aria-invalid={Boolean(error)}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="viewer-chart-settings-actions">
              <button
                type="button"
                className="viewer-command"
                onClick={() => {
                  onChange("");
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

export function ValueFilterButton({
  value,
  onChange,
}: {
  value: ValueBounds;
  onChange: (value: ValueBounds) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const minimumInput = useRef<HTMLInputElement>(null);
  const active = value.min !== undefined || value.max !== undefined;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError("");
      }}
    >
      <ControlTooltip
        content={`Filter readings on every chart by minimum and maximum value. Blank bounds are unrestricted.${active ? ` Current range: ${value.min ?? "unrestricted"} to ${value.max ?? "unrestricted"}.` : ""}`}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="viewer-command viewer-chart-setting-button"
            data-active={active}
          >
            <SlidersHorizontal size={17} aria-hidden="true" /> Min/Max
          </button>
        </Popover.Trigger>
      </ControlTooltip>
      <Popover.Portal>
        <Popover.Content
          className="viewer-chart-settings-popup"
          aria-label="Chart value filter"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            minimumInput.current?.focus();
          }}
        >
          <div className="viewer-app-info-title">
            <h3>Min/Max</h3>
            <Popover.Close asChild>
              <IconButton
                title="Close value filter"
                tooltip="Close without applying changes"
              >
                <X size={16} />
              </IconButton>
            </Popover.Close>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const inputs = new FormData(event.currentTarget);
              try {
                onChange(
                  parseValueBounds(
                    String(inputs.get("min") ?? ""),
                    String(inputs.get("max") ?? ""),
                  ),
                );
                setOpen(false);
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          >
            <label>
              Minimum
              <input
                name="min"
                ref={minimumInput}
                type="number"
                step="any"
                aria-label="Minimum chart value"
                defaultValue={value.min ?? ""}
                aria-invalid={Boolean(error)}
              />
            </label>
            <label>
              Maximum
              <input
                name="max"
                type="number"
                step="any"
                aria-label="Maximum chart value"
                defaultValue={value.max ?? ""}
                aria-invalid={Boolean(error)}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="viewer-chart-settings-actions">
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

const DETAIL_OPTIONS: { value: ChartDetail; name: string; tooltip: string }[] =
  [
    {
      value: "standard",
      name: "Standard",
      tooltip:
        "Fewer display samples for faster rendering. Downloads stay full resolution.",
    },
    {
      value: "high",
      name: "High",
      tooltip:
        "Higher display detail with balanced rendering speed. Downloads stay full resolution.",
    },
    {
      value: "maximum",
      name: "Maximum",
      tooltip:
        "Most display samples. May take longer to render. Downloads stay full resolution.",
    },
  ];

export function ChartDetailButton({
  value,
  onChange,
}: {
  value: ChartDetail;
  onChange: (value: ChartDetail) => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  return (
    <Popover.Root>
      <ControlTooltip
        content={`Chart detail: ${DETAIL_OPTIONS.find((option) => option.value === value)!.name}. Display detail only. Zooming reveals more samples; downloads always retain full resolution.`}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="viewer-icon-button"
            aria-label="Chart detail"
            data-detail={value}
          >
            <ChartNoAxesColumnIncreasing size={18} aria-hidden="true" />
          </button>
        </Popover.Trigger>
      </ControlTooltip>
      <Popover.Portal>
        <Popover.Content
          className="viewer-chart-settings-popup viewer-chart-detail-popup"
          aria-label="Chart detail options"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            selected.current?.focus();
          }}
        >
          {DETAIL_OPTIONS.map((option) => (
            <ControlTooltip key={option.value} content={option.tooltip}>
              <Popover.Close asChild>
                <button
                  ref={value === option.value ? selected : undefined}
                  type="button"
                  className="viewer-command viewer-chart-detail-option"
                  aria-pressed={value === option.value}
                  onClick={() => onChange(option.value)}
                >
                  <Check
                    size={16}
                    aria-hidden="true"
                    visibility={value === option.value ? "visible" : "hidden"}
                  />
                  {option.name}
                </button>
              </Popover.Close>
            </ControlTooltip>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
