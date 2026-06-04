import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreditCard, Trash2, Upload, CheckCircle, Wand2 } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface VCCCardInfo {
  id: number;
  last4: string;
  exp: string;
  name: string;
  status: string;
}

interface VCCPoolStatus {
  count: number;
  cards: VCCCardInfo[];
}

interface VCCTransaction {
  id: number;
  accountId: number;
  cardLast4: string;
  cardBrand: string;
  status: string;
  createdAt: string;
  email: string | null;
}

export default function VccPool() {
  const [pool, setPool] = useState<VCCPoolStatus>({ count: 0, cards: [] });
  const [transactions, setTransactions] = useState<VCCTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [genBin, setGenBin] = useState("515462");
  const [genCount, setGenCount] = useState(10);
  const [genExpMonth, setGenExpMonth] = useState("05");
  const [genExpYear, setGenExpYear] = useState("2030");
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<VCCPoolStatus>("/api/vcc/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, cards: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchApi<{ transactions: VCCTransaction[] }>("/api/vcc/transactions");
      setTransactions(data.transactions || []);
    } catch {
      setTransactions([]);
    }
  }, []);

  useEffect(() => {
    loadPool();
    loadTransactions();
  }, [loadPool, loadTransactions]);

  const handleGenerate = () => {
    if (!genBin || genBin.length < 4) {
      setMessage("BIN must be at least 4 digits");
      return;
    }
    const cards: string[] = [];
    for (let i = 0; i < genCount; i++) {
      const number = generateLuhnNumber(genBin, 16);
      const cvv = String(Math.floor(Math.random() * 900) + 100);
      cards.push(`${number}|${genExpMonth}|${genExpYear}|${cvv}`);
    }
    setBulkText((prev) => (prev ? prev + "\n" : "") + cards.join("\n"));
    setMessage(`Generated ${genCount} cards`);
  };

  function generateLuhnNumber(bin: string, length: number): string {
    const digits = bin.split("").map(Number);
    while (digits.length < length - 1) {
      digits.push(Math.floor(Math.random() * 10));
    }
    // Calculate Luhn check digit
    let sum = 0;
    let alt = true;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits[i];
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    digits.push(checkDigit);
    return digits.join("");
  }

  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste VCC list first");
      return;
    }

    const lines = bulkText.trim().split("\n").filter(l => l.trim());
    const cards = lines.map(line => {
      const parts = line.split("|").map(p => p.trim());
      // Format: number|month|year|cvv (e.g. 5154620022230003|05|2030|135)
      if (parts.length === 4 && parts[0]!.length >= 13) {
        return {
          number: parts[0]!.replace(/\s/g, ""),
          exp: `${parts[1]}/${parts[2]!.slice(-2)}`,
          cvv: parts[3]!,
          name: "John Doe",
        };
      }
      // Format: number|exp|cvv (e.g. 4242424242424242|12/28|123)
      if (parts.length === 3) {
        return {
          number: parts[0]!.replace(/\s/g, ""),
          exp: parts[1]!,
          cvv: parts[2]!,
          name: "John Doe",
        };
      }
      // Comma-separated fallback
      const commaParts = line.split(",").map(p => p.trim());
      if (commaParts.length === 4 && commaParts[0]!.length >= 13) {
        return {
          number: commaParts[0]!.replace(/\s/g, ""),
          exp: `${commaParts[1]}/${commaParts[2]!.slice(-2)}`,
          cvv: commaParts[3]!,
          name: "John Doe",
        };
      }
      if (commaParts.length === 3) {
        return {
          number: commaParts[0]!.replace(/\s/g, ""),
          exp: commaParts[1]!,
          cvv: commaParts[2]!,
          name: "John Doe",
        };
      }
      return null;
    }).filter(Boolean);

    if (cards.length === 0) {
      setMessage("No valid cards found. Use format: number|month|year|cvv");
      return;
    }

    try {
      const result = await fetchApi<{ added: number }>("/api/vcc/pool", {
        method: "POST",
        body: JSON.stringify({ cards }),
      });
      setBulkText("");
      setMessage(`${result.added} cards imported`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Import failed");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/vcc/pool/${id}`, { method: "DELETE" });
      setMessage("Card removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove card");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all active VCC cards from pool?")) return;
    try {
      await fetchApi("/api/vcc/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">VCC Pool</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Manage virtual credit cards for Kiro Pro auto-upgrade
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">
            {pool.count} active card{pool.count !== 1 ? "s" : ""}
          </span>
          {pool.count > 0 && (
            <Button variant="outline" size="sm" onClick={handleClearAll}>
              <Trash2 className="w-3 h-3 mr-1" />
              Clear All
            </Button>
          )}
        </div>
      </div>

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* VCC Generator */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4" />
              Generate VCC
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="BIN prefix (e.g. 515462)"
              value={genBin}
              onChange={(e) => setGenBin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
            <div className="grid grid-cols-3 gap-3">
              <Input
                placeholder="Month (MM)"
                value={genExpMonth}
                onChange={(e) => setGenExpMonth(e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
              <Input
                placeholder="Year (YYYY)"
                value={genExpYear}
                onChange={(e) => setGenExpYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
              <Input
                type="number"
                placeholder="Count"
                value={genCount}
                onChange={(e) => setGenCount(Math.max(1, Math.min(100, Number(e.target.value))))}
              />
            </div>
            <Button onClick={handleGenerate} className="w-full">
              <Wand2 className="w-4 h-4 mr-2" />
              Generate {genCount} Cards
            </Button>
          </CardContent>
        </Card>

        {/* Bulk Import */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Bulk Import
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              className="w-full h-[140px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
              placeholder={"Paste VCC list (one per line):\nnumber|month|year|cvv\n\nExample:\n5154620022230003|05|2030|135\n5154620022454874|05|2030|266"}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
            />
            <Button onClick={handleBulkImport} className="w-full">
              <Upload className="w-4 h-4 mr-2" />
              Import Cards
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Current Pool */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Cards</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : pool.cards.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No active cards in pool. Add cards above to enable Kiro Pro auto-upgrade.
            </p>
          ) : (
            <div className="space-y-2">
              {pool.cards.map((card) => (
                <div
                  key={card.id}
                  className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="flex items-center gap-3">
                    <CreditCard className="w-4 h-4 text-[var(--muted-foreground)]" />
                    <span className="font-mono text-sm">
                      **** **** **** {card.last4}
                    </span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {card.exp}
                    </span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {card.name}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(card.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transaction History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Upgrade History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No upgrade transactions yet.
            </p>
          ) : (
            <div className="space-y-2">
              {transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                    <span className="font-mono text-sm">
                      **** {tx.cardLast4}
                    </span>
                    <span className="text-sm text-[var(--foreground)]">
                      {tx.email || `Account #${tx.accountId}`}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      tx.status === "success"
                        ? "bg-[var(--success)]/10 text-[var(--success)]"
                        : "bg-[var(--error)]/10 text-[var(--error)]"
                    }`}>
                      {tx.status}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {new Date(tx.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
