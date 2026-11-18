"use client";

import { useI18n } from "@/lib/i18n/context";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useDepartmentActions, useDepartments } from "@/hooks/use-staff";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function DepartmentsCard() {
  const { t } = useI18n();
  const { data: departments, isLoading } = useDepartments();
  const { create, rename, remove } = useDepartmentActions();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    create.mutate(n, {
      onSuccess: () => {
        setName("");
        toast.success(t("settings.departments.added", { name: n }));
      },
      onError: (err) => toast.error(msg(err, t("settings.departments.error"))),
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.departments.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.departments.intro")}
        </p>
      </div>

      <form onSubmit={add} className="flex gap-2">
        <Input
          aria-label={t("settings.departments.newNameAria")}
          placeholder={t("settings.departments.newPlaceholder")}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
          {t("settings.departments.add")}
        </Button>
      </form>

      {isLoading ? null : departments && departments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {departments.map((d) => (
            <li key={d.id} className="flex items-center gap-1 rounded-lg border border-border bg-background py-1 pr-1 pl-3 text-sm">
              {editing?.id === d.id ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename.mutate(
                      { id: d.id, name: editing.name.trim() },
                      { onSuccess: () => setEditing(null), onError: (err) => toast.error(msg(err, t("settings.departments.error"))) },
                    );
                  }}
                >
                  <Input
                    aria-label={t("settings.departments.renameAria", { name: d.name })}
                    autoFocus
                    className="h-7 w-36"
                    value={editing.name}
                    maxLength={60}
                    onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                  />
                  <Button type="submit" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("settings.departments.saveName")}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t("settings.departments.cancel")} onClick={() => setEditing(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </form>
              ) : (
                <>
                  <span className="font-medium text-foreground">{d.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{d._count.users}</span>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label={t("settings.departments.renameAria", { name: d.name })} onClick={() => setEditing({ id: d.id, name: d.name })}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    aria-label={t("settings.departments.deleteAria", { name: d.name })}
                    onClick={() => {
                      if (!confirm(t("settings.departments.deleteConfirm", { name: d.name, count: d._count.users }))) return;
                      remove.mutate(d.id, { onError: (err) => toast.error(msg(err, t("settings.departments.error"))) });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings.departments.empty")}</p>
      )}
    </Card>
  );
}
