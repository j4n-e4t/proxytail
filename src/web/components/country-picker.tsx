import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { countryFlag, countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

const byName = (a: string, b: string) => countryName(a).localeCompare(countryName(b));

/** A country with its flag, e.g. in a list of requests. */
export function Country({ code, className }: { code: string | null; className?: string }) {
  if (!code) return <span className={cn("text-muted-foreground", className)}>Unknown</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span aria-hidden>{countryFlag(code)}</span>
      <span className="truncate">{countryName(code)}</span>
    </span>
  );
}

/** Picks any number of countries: the chosen ones as removable chips, the others in a searchable list. */
export function CountryPicker(props: {
  /** Codes to offer: the country database's. */
  available: string[];
  value: string[];
  onChange: (codes: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Chosen countries stay listed even if the database doesn't know them (anymore).
  const options = [...new Set([...props.available, ...props.value])].sort(byName);
  const toggle = (code: string) =>
    props.onChange(props.value.includes(code) ? props.value.filter((c) => c !== code) : [...props.value, code]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...props.value].sort(byName).map((code) => (
        <Badge key={code} variant="secondary" className="h-7 gap-1.5 pr-1 pl-2.5 text-sm font-normal">
          <span aria-hidden>{countryFlag(code)}</span>
          {countryName(code)}
          <button
            type="button"
            onClick={() => toggle(code)}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={`Remove ${countryName(code)}`}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" role="combobox" aria-expanded={open} className="h-7">
            <Plus /> {props.value.length ? "Add" : "Add countries"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search countries…" />
            <CommandList>
              <CommandEmpty>No country found.</CommandEmpty>
              <CommandGroup>
                {options.map((code) => (
                  <CommandItem key={code} value={`${countryName(code)} ${code}`} onSelect={() => toggle(code)} className="gap-2.5">
                    <span aria-hidden>{countryFlag(code)}</span>
                    <span className="truncate">{countryName(code)}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{code}</span>
                    <Check className={cn("size-4", props.value.includes(code) ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
