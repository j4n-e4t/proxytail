import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OsIcon } from "@/components/os-icon";
import { StatusDot } from "@/components/status";
import type { Device } from "@/lib/api";
import { cn } from "@/lib/utils";

export function DevicePicker(props: {
  devices: Device[];
  /** The backend tag, for the empty state. */
  tag: string;
  value: string;
  onChange: (id: string) => void;
  /** Shown when the selected device isn't in the (possibly unavailable) device list. */
  fallbackLabel?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.devices.find((d) => d.id === props.value);
  const usable = props.devices.filter((d) => d.ipv4);
  const groups = [
    { heading: "Online", items: usable.filter((d) => d.online) },
    { heading: "Offline", items: usable.filter((d) => !d.online) },
  ].filter((g) => g.items.length);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={props.invalid}
          className="h-10 w-full justify-between px-3 font-normal"
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusDot status={selected.online ? "online" : "offline"} />
              <span className="truncate font-medium">{selected.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{selected.ipv4}</span>
            </span>
          ) : props.value && props.fallbackLabel ? (
            <span className="flex items-center gap-2.5">
              <StatusDot status="unknown" />
              <span className="truncate">{props.fallbackLabel}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Select a peer…</span>
          )}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name, IP, OS or tag…" />
          <CommandList>
            <CommandEmpty>
              {usable.length ? "No peers found." : `No peers tagged ${props.tag}.`}
            </CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.items.map((d) => (
                  <CommandItem
                    key={d.id}
                    value={[d.name, d.ipv4, d.os, ...d.tags, d.id].join(" ")}
                    onSelect={() => {
                      props.onChange(d.id);
                      setOpen(false);
                    }}
                    className="gap-2.5"
                  >
                    <OsIcon os={d.os} className="text-muted-foreground" />
                    <span className="font-medium">{d.name}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{d.ipv4}</span>
                    <Check className={cn("size-4", d.id === props.value ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
