//+------------------------------------------------------------------+
//|  VantageBridgeEA.mq5 - ByTrader MT5 bridge, protocol v2          |
//|                                                                  |
//|  ZeroMQ REP server. The Node.js AutoTrader (REQ side) sends one  |
//|  JSON request per call and receives exactly one JSON reply.      |
//|                                                                  |
//|  Request:  {"v":2,"request_id":"...","action":"ORDER_SEND",      |
//|             "expires_at":<unix s, TimeGMT basis>, ...params}     |
//|  Reply:    {"ok":true,"retcode":0,"request_id":"...",            |
//|             "replayed":false,"data":{...}}                       |
//|                                                                  |
//|  Mutating actions (ORDER_SEND, POSITION_MODIFY, ORDER_MODIFY,    |
//|  PENDING_MODIFY, CLOSE_POSITION, CANCEL_ORDER) need expires_at   |
//|  (4001 if missing) and are refused with 5009 once TimeGMT() is   |
//|  past it. A repeated non-empty request_id for a mutating action  |
//|  returns the cached reply with "replayed":true and does not      |
//|  execute again (ring buffer of 256, lost on EA restart).         |
//|                                                                  |
//|  Requests are drained by OnTimer (EventSetMillisecondTimer,      |
//|  InpPollIntervalMs, min 10 ms) and by OnTick, up to 20 per pass  |
//|  with ZMQ_DONTWAIT. Full reference: mql5/PROTOCOL.md.            |
//|                                                                  |
//|  Dependencies (NOT bundled in this repo, see SETUP_INSTRUCTIONS):|
//|    MQL5/Include/Zmq/       mql-zmq headers (import libzmq.dll)   |
//|    MQL5/Include/Mql/       Lang helpers included by Zmq headers  |
//|    MQL5/Include/JAson.mqh  CJAVal JSON parser (MQL5 code #13663) |
//|    MQL5/Libraries/libzmq.dll and libsodium.dll                   |
//|  The EA needs "Allow DLL imports" and "Allow Algo Trading".      |
//+------------------------------------------------------------------+

#property copyright "ByTrader"
#property version   "2.00"

#include <Zmq/Zmq.mqh>
#include <JAson.mqh>
#include <Trade/Trade.mqh>

#define EA_VERSION          "2.0.0"
#define PROTOCOL_VERSION    2
#define MAX_PER_PASS        20
#define REPLAY_CACHE_SIZE   256
#define DUP_LOOKBACK_SEC    604800   // 7 days
#define VOLUME_EPS          1e-9
#define PRICE_EPS           1e-9

// ---------------------------------------------------------------------------
// Input parameters
// ---------------------------------------------------------------------------

input string InpEndpoint       = "tcp://127.0.0.1:5555"; // ZeroMQ REP bind address (localhost only)
input int    InpMagicNumber    = 98801;                  // EA magic; requests with another magic get 5010
input int    InpDeviation      = 20;                     // Default max slippage in points
input int    InpPollIntervalMs = 20;                     // Request poll period in ms (clamped to >= 10)
input bool   InpAutoSuffix     = true;                   // Auto-detect broker symbol suffix at init

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

Context  *g_ctx    = NULL;
Socket   *g_socket = NULL;
CTrade    g_trade;
string    g_symbol = "";   // Resolved base symbol (e.g. "XAUUSD+")

struct Reply
{
   bool   ok;
   int    retcode;
   string error;
   string data;       // JSON object text, "" means {}
};

struct CachedReply
{
   string request_id;
   Reply  reply;
};

CachedReply g_cache[REPLAY_CACHE_SIZE];
int         g_cache_count = 0;
int         g_cache_next  = 0;

// ---------------------------------------------------------------------------
// Reply and JSON output helpers (output is built by hand so that prices
// are rendered with fixed digits and the replayed flag can be set)
// ---------------------------------------------------------------------------

Reply MakeOk(string data = "")
{
   Reply r;
   r.ok      = true;
   r.retcode = 0;
   r.error   = "";
   r.data    = data;
   return r;
}

Reply MakeErr(int code, string message, string data = "")
{
   Reply r;
   r.ok      = false;
   r.retcode = code;
   r.error   = message;
   r.data    = data;
   return r;
}

string JsonEscape(string s)
{
   string out = "";
   int n = StringLen(s);
   for (int i = 0; i < n; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if      (c == '\\') out += "\\\\";
      else if (c == '"')  out += "\\\"";
      else if (c == '\n') out += "\\n";
      else if (c == '\r') out += "\\r";
      else if (c == '\t') out += "\\t";
      else if (c < 32)    out += StringFormat("\\u%04X", c);
      else                out += ShortToString((short)c);
   }
   return out;
}

string KvS(string key, string value) { return "\"" + key + "\":\"" + JsonEscape(value) + "\""; }
string KvL(string key, long value)   { return "\"" + key + "\":" + IntegerToString(value); }
string KvD(string key, double value, int digits) { return "\"" + key + "\":" + DoubleToString(value, digits); }
string KvB(string key, bool value)   { return "\"" + key + "\":" + (value ? "true" : "false"); }

// Join two JSON fragments with a comma, skipping empty ones.
string JAdd(string a, string b)
{
   if (a == "") return b;
   if (b == "") return a;
   return a + "," + b;
}

string JObj(string body) { return "{" + body + "}"; }
string JArr(string body) { return "[" + body + "]"; }

string BuildResponse(string request_id, Reply &r, bool replayed)
{
   string body = KvB("ok", r.ok);
   body = JAdd(body, KvL("retcode", r.retcode));
   if (!r.ok) body = JAdd(body, KvS("error", r.error));
   body = JAdd(body, KvS("request_id", request_id));
   body = JAdd(body, KvB("replayed", replayed));
   body = JAdd(body, "\"data\":" + (r.data == "" ? "{}" : r.data));
   return JObj(body);
}

// ---------------------------------------------------------------------------
// Request field readers (never call operator[] on a missing key: JAson
// would insert an undefined child into the request object)
// ---------------------------------------------------------------------------

string FieldStr(CJAVal &o, string key)
{
   if (!o.HasKey(key)) return "";
   return o[key].ToStr();
}

double FieldDbl(CJAVal &o, string key)
{
   if (!o.HasKey(key)) return 0.0;
   return o[key].ToDbl();
}

long FieldLong(CJAVal &o, string key)
{
   if (!o.HasKey(key)) return 0;
   return o[key].ToInt();
}

bool FieldBool(CJAVal &o, string key)
{
   if (!o.HasKey(key)) return false;
   return o[key].ToBool();
}

// ---------------------------------------------------------------------------
// Enum mapping helpers
// ---------------------------------------------------------------------------

bool IsMutatingAction(string action)
{
   return action == "ORDER_SEND"     || action == "POSITION_MODIFY" ||
          action == "ORDER_MODIFY"   || action == "PENDING_MODIFY"  ||
          action == "CLOSE_POSITION" || action == "CANCEL_ORDER";
}

bool ParseOrderType(string text, ENUM_ORDER_TYPE &type)
{
   if      (text == "BUY")        type = ORDER_TYPE_BUY;
   else if (text == "SELL")       type = ORDER_TYPE_SELL;
   else if (text == "BUY_LIMIT")  type = ORDER_TYPE_BUY_LIMIT;
   else if (text == "SELL_LIMIT") type = ORDER_TYPE_SELL_LIMIT;
   else if (text == "BUY_STOP")   type = ORDER_TYPE_BUY_STOP;
   else if (text == "SELL_STOP")  type = ORDER_TYPE_SELL_STOP;
   else return false;
   return true;
}

bool IsMarketType(ENUM_ORDER_TYPE t)
{
   return t == ORDER_TYPE_BUY || t == ORDER_TYPE_SELL;
}

bool IsBuySide(ENUM_ORDER_TYPE t)
{
   return t == ORDER_TYPE_BUY || t == ORDER_TYPE_BUY_LIMIT || t == ORDER_TYPE_BUY_STOP;
}

string OrderTypeLabel(long t)
{
   if (t == ORDER_TYPE_BUY_LIMIT)  return "BUY_LIMIT";
   if (t == ORDER_TYPE_SELL_LIMIT) return "SELL_LIMIT";
   if (t == ORDER_TYPE_BUY_STOP)   return "BUY_STOP";
   if (t == ORDER_TYPE_SELL_STOP)  return "SELL_STOP";
   return "OTHER";
}

string TradeModeName(long m)
{
   if (m == SYMBOL_TRADE_MODE_DISABLED)  return "DISABLED";
   if (m == SYMBOL_TRADE_MODE_LONGONLY)  return "LONGONLY";
   if (m == SYMBOL_TRADE_MODE_SHORTONLY) return "SHORTONLY";
   if (m == SYMBOL_TRADE_MODE_CLOSEONLY) return "CLOSEONLY";
   return "FULL";
}

string ExecutionModeName(long m)
{
   if (m == SYMBOL_TRADE_EXECUTION_REQUEST) return "REQUEST";
   if (m == SYMBOL_TRADE_EXECUTION_INSTANT) return "INSTANT";
   if (m == SYMBOL_TRADE_EXECUTION_MARKET)  return "MARKET";
   if (m == SYMBOL_TRADE_EXECUTION_EXCHANGE) return "EXCHANGE";
   return "UNKNOWN";
}

string MarginModeName(long m)
{
   if (m == ACCOUNT_MARGIN_MODE_RETAIL_NETTING) return "NETTING";
   if (m == ACCOUNT_MARGIN_MODE_EXCHANGE)       return "EXCHANGE";
   if (m == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) return "HEDGING";
   return "UNKNOWN";
}

string AccountTradeModeName(long m)
{
   if (m == ACCOUNT_TRADE_MODE_DEMO)    return "DEMO";
   if (m == ACCOUNT_TRADE_MODE_CONTEST) return "CONTEST";
   return "REAL";
}

int DigitsOf(string sym)
{
   long d = SymbolInfoInteger(sym, SYMBOL_DIGITS);
   return (d > 0) ? (int)d : 8;
}

// Preferred fill policy for market orders: FOK, then IOC, then RETURN.
ENUM_ORDER_TYPE_FILLING MarketFillingMode(string sym)
{
   long flags = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if ((flags & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if ((flags & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

bool IsBrokerSuccess(uint rc)
{
   return rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL;
}

// Converts the last CTrade result into a reply. A zero broker retcode means
// CTrade never reached the broker, which is reported as 4001.
Reply BrokerFailure()
{
   uint   rc   = g_trade.ResultRetcode();
   string desc = g_trade.ResultRetcodeDescription();
   if (rc == 0) return MakeErr(4001, "request not sent: " + desc);
   return MakeErr((int)rc, desc);
}

// ---------------------------------------------------------------------------
// Symbol resolution
// ---------------------------------------------------------------------------

bool SymbolUsable(string sym)
{
   if (sym == "") return false;
   bool custom = false;
   if (!SymbolExist(sym, custom)) return false;
   return SymbolSelect(sym, true);
}

// Tries the suffix list regardless of InpAutoSuffix. Returns "" when nothing matches.
string ResolveSymbolAuto(string base)
{
   string suffixes[] = {"", "+", ".raw", ".Raw", "m", "pro"};
   for (int i = 0; i < ArraySize(suffixes); i++)
   {
      string candidate = base + suffixes[i];
      if (SymbolUsable(candidate)) return candidate;
   }
   return "";
}

string ResolveSymbol(string base)
{
   if (!InpAutoSuffix) return base;
   string resolved = ResolveSymbolAuto(base);
   if (resolved == "")
   {
      Print("[Bridge] WARNING: could not resolve symbol for base '", base, "', using it as-is");
      return base;
   }
   return resolved;
}

// ---------------------------------------------------------------------------
// Trading gates and validation
// ---------------------------------------------------------------------------

bool GateTrading(Reply &err)
{
   if (TerminalInfoInteger(TERMINAL_CONNECTED) == 0)
   {
      err = MakeErr(5001, "terminal not connected to trade server");
      return false;
   }
   if (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) == 0)
   {
      err = MakeErr(5002, "terminal AutoTrading is disabled");
      return false;
   }
   if (MQLInfoInteger(MQL_TRADE_ALLOWED) == 0)
   {
      err = MakeErr(5002, "MQL program trading is disabled (Allow Algo Trading)");
      return false;
   }
   if (AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) == 0)
   {
      err = MakeErr(5002, "trading is not allowed on this account");
      return false;
   }
   if (AccountInfoInteger(ACCOUNT_TRADE_EXPERT) == 0)
   {
      err = MakeErr(5002, "expert advisor trading is not allowed on this account");
      return false;
   }
   return true;
}

// isEntry: true for ORDER_SEND (market or pending). Close and modify actions
// pass false; they are blocked only by DISABLED.
bool SymbolModeAllows(string sym, bool isEntry, bool buySide, Reply &err)
{
   long mode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   bool allowed = true;
   if (mode == SYMBOL_TRADE_MODE_DISABLED)                           allowed = false;
   else if (isEntry && mode == SYMBOL_TRADE_MODE_CLOSEONLY)          allowed = false;
   else if (isEntry && mode == SYMBOL_TRADE_MODE_LONGONLY && !buySide)  allowed = false;
   else if (isEntry && mode == SYMBOL_TRADE_MODE_SHORTONLY && buySide)  allowed = false;

   if (!allowed)
      err = MakeErr(5003, "symbol " + sym + " trade mode " + TradeModeName(mode) + " forbids this operation");
   return allowed;
}

bool CheckVolume(string sym, double vol, Reply &err)
{
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);

   if (vol <= 0)
   {
      err = MakeErr(5004, "volume must be > 0");
      return false;
   }
   if (vmin > 0 && vol < vmin - VOLUME_EPS)
   {
      err = MakeErr(5004, "volume " + DoubleToString(vol, 8) + " below min " + DoubleToString(vmin, 8));
      return false;
   }
   if (vmax > 0 && vol > vmax + VOLUME_EPS)
   {
      err = MakeErr(5004, "volume " + DoubleToString(vol, 8) + " above max " + DoubleToString(vmax, 8));
      return false;
   }
   if (step > 0)
   {
      double q = vol / step;
      if (MathAbs(q - MathRound(q)) >= 1e-6)
      {
         err = MakeErr(5004, "volume " + DoubleToString(vol, 8) + " is not a multiple of step " + DoubleToString(step, 8));
         return false;
      }
   }
   return true;
}

// Side and stops-level checks. buySide selects the orientation: for BUY the
// SL must be below and TP above the reference price, and vice versa for SELL.
// refPrice is Bid/Ask for market orders and positions (BUY compares with Bid,
// SELL with Ask) and the pending price for pending orders.
bool CheckStops(string sym, bool buySide, double refPrice, double sl, double tp,
                bool checkSl, bool checkTp, Reply &err)
{
   double point   = SymbolInfoDouble(sym, SYMBOL_POINT);
   double minDist = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;

   if (checkSl && sl > 0)
   {
      bool sideOk = buySide ? (sl < refPrice) : (sl > refPrice);
      if (!sideOk)
      {
         err = MakeErr(5005, "SL " + DoubleToString(sl, 8) + " on wrong side of reference " + DoubleToString(refPrice, 8));
         return false;
      }
      if (MathAbs(refPrice - sl) < minDist - PRICE_EPS)
      {
         err = MakeErr(5005, "SL inside stops level (" + DoubleToString(minDist, 8) + ")");
         return false;
      }
   }
   if (checkTp && tp > 0)
   {
      bool sideOk = buySide ? (tp > refPrice) : (tp < refPrice);
      if (!sideOk)
      {
         err = MakeErr(5005, "TP " + DoubleToString(tp, 8) + " on wrong side of reference " + DoubleToString(refPrice, 8));
         return false;
      }
      if (MathAbs(refPrice - tp) < minDist - PRICE_EPS)
      {
         err = MakeErr(5005, "TP inside stops level (" + DoubleToString(minDist, 8) + ")");
         return false;
      }
   }
   return true;
}

// Freeze check: an existing SL/TP or pending price that lies within the freeze
// distance of the market cannot be changed.
bool CheckFreeze(string sym, double marketPrice, double currentLevel, Reply &err)
{
   if (currentLevel <= 0) return true;
   double point   = SymbolInfoDouble(sym, SYMBOL_POINT);
   double minDist = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL) * point;
   if (minDist > 0 && MathAbs(marketPrice - currentLevel) < minDist - PRICE_EPS)
   {
      err = MakeErr(5005, "modification denied: " + DoubleToString(currentLevel, 8) +
                          " is inside freeze level (" + DoubleToString(minDist, 8) + ")");
      return false;
   }
   return true;
}

// ---------------------------------------------------------------------------
// Duplicate guard: identical comment + EA magic over open positions, pending
// orders and deals in the last 7 days.
// ---------------------------------------------------------------------------

void FindEntryDeal(long positionId, ulong &deal, ulong &order)
{
   deal  = 0;
   order = 0;
   if (!HistorySelectByPosition(positionId)) return;
   for (int i = 0; i < HistoryDealsTotal(); i++)
   {
      ulong t = HistoryDealGetTicket(i);
      if (t == 0) continue;
      if (HistoryDealGetInteger(t, DEAL_ENTRY) == DEAL_ENTRY_IN)
      {
         deal  = t;
         order = (ulong)HistoryDealGetInteger(t, DEAL_ORDER);
         return;
      }
   }
}

string OrderResultBody(long retcode, ulong order, ulong deal, long position,
                       double price, double volume, int digits, bool duplicate, string dupOf)
{
   string d = KvL("retcode", retcode);
   d = JAdd(d, KvL("order", (long)order));
   d = JAdd(d, KvL("deal", (long)deal));
   d = JAdd(d, KvL("position", position));
   d = JAdd(d, KvD("price", price, digits));
   d = JAdd(d, KvD("volume", volume, 8));
   d = JAdd(d, KvB("duplicate", duplicate));
   if (duplicate) d = JAdd(d, KvS("duplicate_of", dupOf));
   return d;
}

bool FindDuplicate(string comment, Reply &result)
{
   // Open positions
   for (int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0) continue;
      if (PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      if (PositionGetString(POSITION_COMMENT) != comment) continue;

      long   identifier = PositionGetInteger(POSITION_IDENTIFIER);
      int    digits     = DigitsOf(PositionGetString(POSITION_SYMBOL));
      ulong  entryDeal  = 0;
      ulong  entryOrder = 0;
      FindEntryDeal(identifier, entryDeal, entryOrder);
      string body = OrderResultBody(0, entryOrder, entryDeal, (long)ticket,
                                    PositionGetDouble(POSITION_PRICE_OPEN),
                                    PositionGetDouble(POSITION_VOLUME), digits, true, "position");
      result = MakeOk(JObj(body));
      return true;
   }

   // Pending orders
   for (int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if (ticket == 0) continue;
      if (OrderGetInteger(ORDER_MAGIC) != InpMagicNumber) continue;
      if (OrderGetString(ORDER_COMMENT) != comment) continue;

      int    digits = DigitsOf(OrderGetString(ORDER_SYMBOL));
      string body   = OrderResultBody(0, ticket, 0, 0,
                                      OrderGetDouble(ORDER_PRICE_OPEN),
                                      OrderGetDouble(ORDER_VOLUME_INITIAL), digits, true, "order");
      result = MakeOk(JObj(body));
      return true;
   }

   // Deals in the last 7 days
   datetime now = TimeCurrent();
   HistorySelect(now - DUP_LOOKBACK_SEC, now + 60);
   for (int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if (ticket == 0) continue;
      if (HistoryDealGetInteger(ticket, DEAL_MAGIC) != InpMagicNumber) continue;
      if (HistoryDealGetString(ticket, DEAL_COMMENT) != comment) continue;

      int    digits = DigitsOf(HistoryDealGetString(ticket, DEAL_SYMBOL));
      string body   = OrderResultBody(0, (ulong)HistoryDealGetInteger(ticket, DEAL_ORDER), ticket,
                                      HistoryDealGetInteger(ticket, DEAL_POSITION_ID),
                                      HistoryDealGetDouble(ticket, DEAL_PRICE),
                                      HistoryDealGetDouble(ticket, DEAL_VOLUME), digits, true, "deal");
      result = MakeOk(JObj(body));
      return true;
   }
   return false;
}

// Position ticket of the deal that opened or changed a position. 0 if unknown.
long PositionFromDeal(ulong deal)
{
   if (!HistoryDealSelect(deal))
   {
      datetime now = TimeCurrent();
      HistorySelect(now - 86400, now + 60);
      if (!HistoryDealSelect(deal)) return 0;
   }
   return HistoryDealGetInteger(deal, DEAL_POSITION_ID);
}

// ---------------------------------------------------------------------------
// Action: PING / ACCOUNT_INFO / SYMBOL_INFO
// ---------------------------------------------------------------------------

Reply HandlePing()
{
   string d = KvL("server_time", (long)TimeCurrent());
   d = JAdd(d, KvL("gmt_time", (long)TimeGMT()));
   d = JAdd(d, KvS("ea_version", EA_VERSION));
   d = JAdd(d, KvL("magic", InpMagicNumber));
   d = JAdd(d, KvB("terminal_connected", TerminalInfoInteger(TERMINAL_CONNECTED) != 0));
   d = JAdd(d, KvB("terminal_trade_allowed", TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0));
   d = JAdd(d, KvB("mql_trade_allowed", MQLInfoInteger(MQL_TRADE_ALLOWED) != 0));
   return MakeOk(JObj(d));
}

Reply HandleAccountInfo()
{
   string d = KvL("login", AccountInfoInteger(ACCOUNT_LOGIN));
   d = JAdd(d, KvS("trade_mode", AccountTradeModeName(AccountInfoInteger(ACCOUNT_TRADE_MODE))));
   d = JAdd(d, KvS("margin_mode", MarginModeName(AccountInfoInteger(ACCOUNT_MARGIN_MODE))));
   d = JAdd(d, KvS("currency", AccountInfoString(ACCOUNT_CURRENCY)));
   d = JAdd(d, KvD("balance", AccountInfoDouble(ACCOUNT_BALANCE), 2));
   d = JAdd(d, KvD("equity", AccountInfoDouble(ACCOUNT_EQUITY), 2));
   d = JAdd(d, KvD("margin", AccountInfoDouble(ACCOUNT_MARGIN), 2));
   d = JAdd(d, KvD("margin_free", AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2));
   d = JAdd(d, KvD("margin_level", AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2));
   d = JAdd(d, KvL("leverage", AccountInfoInteger(ACCOUNT_LEVERAGE)));
   d = JAdd(d, KvB("trade_allowed", AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0));
   d = JAdd(d, KvB("trade_expert", AccountInfoInteger(ACCOUNT_TRADE_EXPERT) != 0));
   d = JAdd(d, KvB("terminal_trade_allowed", TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0));
   d = JAdd(d, KvS("server", AccountInfoString(ACCOUNT_SERVER)));
   d = JAdd(d, KvS("company", AccountInfoString(ACCOUNT_COMPANY)));
   return MakeOk(JObj(d));
}

Reply HandleSymbolInfo(CJAVal &req)
{
   string requested = FieldStr(req, "symbol");
   if (requested == "") return MakeErr(4001, "symbol required");

   string sym = requested;
   if (FieldBool(req, "auto_suffix")) sym = ResolveSymbolAuto(requested);
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + requested);

   int digits = DigitsOf(sym);
   long fillFlags = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);

   string d = KvS("symbol", sym);
   d = JAdd(d, KvL("digits", digits));
   d = JAdd(d, KvD("point", SymbolInfoDouble(sym, SYMBOL_POINT), 8));
   d = JAdd(d, KvD("tick_size", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 8));
   d = JAdd(d, KvD("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 8));
   d = JAdd(d, KvD("tick_value_profit", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_PROFIT), 8));
   d = JAdd(d, KvD("tick_value_loss", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_LOSS), 8));
   d = JAdd(d, KvD("contract_size", SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 8));
   d = JAdd(d, KvD("volume_min", SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 8));
   d = JAdd(d, KvD("volume_max", SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 8));
   d = JAdd(d, KvD("volume_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 8));
   d = JAdd(d, KvD("volume_limit", SymbolInfoDouble(sym, SYMBOL_VOLUME_LIMIT), 8));
   d = JAdd(d, KvL("stops_level", SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL)));
   d = JAdd(d, KvL("freeze_level", SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL)));
   d = JAdd(d, KvS("trade_mode", TradeModeName(SymbolInfoInteger(sym, SYMBOL_TRADE_MODE))));
   d = JAdd(d, KvS("execution_mode", ExecutionModeName(SymbolInfoInteger(sym, SYMBOL_TRADE_EXEMODE))));
   d = JAdd(d, KvB("filling_fok", (fillFlags & SYMBOL_FILLING_FOK) != 0));
   d = JAdd(d, KvB("filling_ioc", (fillFlags & SYMBOL_FILLING_IOC) != 0));
   d = JAdd(d, KvD("bid", SymbolInfoDouble(sym, SYMBOL_BID), digits));
   d = JAdd(d, KvD("ask", SymbolInfoDouble(sym, SYMBOL_ASK), digits));
   d = JAdd(d, KvL("spread_points", SymbolInfoInteger(sym, SYMBOL_SPREAD)));
   d = JAdd(d, KvL("tick_time_msc", SymbolInfoInteger(sym, SYMBOL_TIME_MSC)));
   d = JAdd(d, KvS("currency_profit", SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT)));
   d = JAdd(d, KvS("currency_margin", SymbolInfoString(sym, SYMBOL_CURRENCY_MARGIN)));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Action: GET_POSITIONS / GET_ORDERS / GET_DEALS (read-only)
// ---------------------------------------------------------------------------

Reply HandleGetPositions(CJAVal &req)
{
   string filterSym   = FieldStr(req, "symbol");
   bool   hasMagic    = req.HasKey("magic");
   long   filterMagic = FieldLong(req, "magic");

   string arr   = "";
   int    count = 0;
   for (int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0) continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      if (filterSym != "" && sym != filterSym) continue;
      long magic = PositionGetInteger(POSITION_MAGIC);
      if (hasMagic && magic != filterMagic) continue;

      int digits = DigitsOf(sym);
      string type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY" : "SELL";

      string p = KvL("ticket", (long)ticket);
      p = JAdd(p, KvL("identifier", PositionGetInteger(POSITION_IDENTIFIER)));
      p = JAdd(p, KvS("symbol", sym));
      p = JAdd(p, KvS("type", type));
      p = JAdd(p, KvD("volume", PositionGetDouble(POSITION_VOLUME), 8));
      p = JAdd(p, KvD("open_price", PositionGetDouble(POSITION_PRICE_OPEN), digits));
      p = JAdd(p, KvD("price_current", PositionGetDouble(POSITION_PRICE_CURRENT), digits));
      p = JAdd(p, KvD("sl", PositionGetDouble(POSITION_SL), digits));
      p = JAdd(p, KvD("tp", PositionGetDouble(POSITION_TP), digits));
      p = JAdd(p, KvD("profit", PositionGetDouble(POSITION_PROFIT), 2));
      p = JAdd(p, KvD("swap", PositionGetDouble(POSITION_SWAP), 2));
      p = JAdd(p, KvL("magic", magic));
      p = JAdd(p, KvS("comment", PositionGetString(POSITION_COMMENT)));
      p = JAdd(p, KvL("time_open", PositionGetInteger(POSITION_TIME)));
      p = JAdd(p, KvL("time_update_msc", PositionGetInteger(POSITION_TIME_UPDATE_MSC)));

      arr = JAdd(arr, JObj(p));
      count++;
   }

   string d = "\"positions\":" + JArr(arr);
   d = JAdd(d, KvL("count", count));
   return MakeOk(JObj(d));
}

Reply HandleGetOrders(CJAVal &req)
{
   string filterSym   = FieldStr(req, "symbol");
   bool   hasMagic    = req.HasKey("magic");
   long   filterMagic = FieldLong(req, "magic");

   string arr   = "";
   int    count = 0;
   for (int i = 0; i < OrdersTotal(); i++)
   {
      ulong ticket = OrderGetTicket(i);
      if (ticket == 0) continue;

      string sym = OrderGetString(ORDER_SYMBOL);
      if (filterSym != "" && sym != filterSym) continue;
      long magic = OrderGetInteger(ORDER_MAGIC);
      if (hasMagic && magic != filterMagic) continue;

      int digits = DigitsOf(sym);

      string o = KvL("ticket", (long)ticket);
      o = JAdd(o, KvS("symbol", sym));
      o = JAdd(o, KvS("type", OrderTypeLabel(OrderGetInteger(ORDER_TYPE))));
      o = JAdd(o, KvD("volume_initial", OrderGetDouble(ORDER_VOLUME_INITIAL), 8));
      o = JAdd(o, KvD("volume_current", OrderGetDouble(ORDER_VOLUME_CURRENT), 8));
      o = JAdd(o, KvD("price_open", OrderGetDouble(ORDER_PRICE_OPEN), digits));
      o = JAdd(o, KvD("sl", OrderGetDouble(ORDER_SL), digits));
      o = JAdd(o, KvD("tp", OrderGetDouble(ORDER_TP), digits));
      o = JAdd(o, KvL("magic", magic));
      o = JAdd(o, KvS("comment", OrderGetString(ORDER_COMMENT)));
      o = JAdd(o, KvL("time_setup", OrderGetInteger(ORDER_TIME_SETUP)));
      o = JAdd(o, KvL("time_expiration", OrderGetInteger(ORDER_TIME_EXPIRATION)));

      arr = JAdd(arr, JObj(o));
      count++;
   }

   string d = "\"orders\":" + JArr(arr);
   d = JAdd(d, KvL("count", count));
   return MakeOk(JObj(d));
}

// from/to are unix seconds in MT5 SERVER time (deal times are server time, not
// GMT). Node should pass a generous window; to defaults to now + 60 s.
Reply HandleGetDeals(CJAVal &req)
{
   if (!req.HasKey("from")) return MakeErr(4001, "from required (unix seconds, server time)");
   datetime from = (datetime)FieldLong(req, "from");
   datetime to   = req.HasKey("to") ? (datetime)FieldLong(req, "to") : (TimeCurrent() + 60);
   if (to < from) return MakeErr(4001, "to is before from");
   if (!HistorySelect(from, to)) return MakeErr(4001, "HistorySelect failed for the requested range");

   bool hasMagic      = req.HasKey("magic");
   long filterMagic   = FieldLong(req, "magic");
   bool hasPosition   = req.HasKey("position_id");
   long filterPos     = FieldLong(req, "position_id");

   string arr   = "";
   int    count = 0;
   for (int i = 0; i < HistoryDealsTotal(); i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if (ticket == 0) continue;

      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if (hasMagic && magic != filterMagic) continue;
      long posId = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      if (hasPosition && posId != filterPos) continue;

      string sym = HistoryDealGetString(ticket, DEAL_SYMBOL);
      int digits = DigitsOf(sym);

      long dtype = HistoryDealGetInteger(ticket, DEAL_TYPE);
      string type = "OTHER";
      if (dtype == DEAL_TYPE_BUY)  type = "BUY";
      if (dtype == DEAL_TYPE_SELL) type = "SELL";

      long   dentry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      string entry  = "OUT";
      if (dentry == DEAL_ENTRY_IN)     entry = "IN";
      if (dentry == DEAL_ENTRY_INOUT)  entry = "INOUT";
      if (dentry == DEAL_ENTRY_OUT_BY) entry = "OUT_BY";

      long   dreason = HistoryDealGetInteger(ticket, DEAL_REASON);
      string reason  = "OTHER";
      if (dreason == DEAL_REASON_CLIENT) reason = "CLIENT";
      if (dreason == DEAL_REASON_EXPERT) reason = "EXPERT";
      if (dreason == DEAL_REASON_SL)     reason = "SL";
      if (dreason == DEAL_REASON_TP)     reason = "TP";
      if (dreason == DEAL_REASON_SO)     reason = "SO";
      if (dreason == DEAL_REASON_MOBILE) reason = "MOBILE";
      if (dreason == DEAL_REASON_WEB)    reason = "WEB";

      string dl = KvL("ticket", (long)ticket);
      dl = JAdd(dl, KvL("order", HistoryDealGetInteger(ticket, DEAL_ORDER)));
      dl = JAdd(dl, KvL("position_id", posId));
      dl = JAdd(dl, KvS("symbol", sym));
      dl = JAdd(dl, KvS("type", type));
      dl = JAdd(dl, KvS("entry", entry));
      dl = JAdd(dl, KvD("volume", HistoryDealGetDouble(ticket, DEAL_VOLUME), 8));
      dl = JAdd(dl, KvD("price", HistoryDealGetDouble(ticket, DEAL_PRICE), digits));
      dl = JAdd(dl, KvD("profit", HistoryDealGetDouble(ticket, DEAL_PROFIT), 2));
      dl = JAdd(dl, KvD("commission", HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2));
      dl = JAdd(dl, KvD("swap", HistoryDealGetDouble(ticket, DEAL_SWAP), 2));
      dl = JAdd(dl, KvD("fee", HistoryDealGetDouble(ticket, DEAL_FEE), 2));
      dl = JAdd(dl, KvL("magic", magic));
      dl = JAdd(dl, KvS("comment", HistoryDealGetString(ticket, DEAL_COMMENT)));
      dl = JAdd(dl, KvL("time", HistoryDealGetInteger(ticket, DEAL_TIME)));
      dl = JAdd(dl, KvL("time_msc", HistoryDealGetInteger(ticket, DEAL_TIME_MSC)));
      dl = JAdd(dl, KvS("reason", reason));

      arr = JAdd(arr, JObj(dl));
      count++;
   }

   string d = "\"deals\":" + JArr(arr);
   d = JAdd(d, KvL("count", count));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Action: ORDER_CHECK (MqlTradeRequest + OrderCheck, no side effects)
// ---------------------------------------------------------------------------

Reply HandleOrderCheck(CJAVal &req)
{
   string typeText = FieldStr(req, "order_type");
   ENUM_ORDER_TYPE otype = ORDER_TYPE_BUY;
   if (!ParseOrderType(typeText, otype)) return MakeErr(4001, "unknown order_type: " + typeText);
   if (!req.HasKey("volume")) return MakeErr(4001, "volume required");

   string sym = FieldStr(req, "symbol");
   if (sym == "") sym = g_symbol;
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);

   int  digits   = DigitsOf(sym);
   bool isMarket = IsMarketType(otype);
   bool buySide  = IsBuySide(otype);

   double price = FieldDbl(req, "price");
   if (isMarket)
   {
      if (price <= 0) price = buySide ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   }
   else if (price <= 0)
   {
      return MakeErr(4001, "price required for " + typeText);
   }
   price = NormalizeDouble(price, digits);

   long deviation = FieldLong(req, "deviation");
   if (deviation <= 0) deviation = InpDeviation;

   MqlTradeRequest tr = {};
   tr.action       = isMarket ? TRADE_ACTION_DEAL : TRADE_ACTION_PENDING;
   tr.symbol       = sym;
   tr.volume       = FieldDbl(req, "volume");
   tr.type         = otype;
   tr.price        = price;
   tr.sl           = NormalizeDouble(FieldDbl(req, "sl"), digits);
   tr.tp           = NormalizeDouble(FieldDbl(req, "tp"), digits);
   tr.deviation    = (ulong)deviation;
   tr.magic        = (ulong)InpMagicNumber;
   tr.comment      = FieldStr(req, "comment");
   tr.type_filling = isMarket ? MarketFillingMode(sym) : ORDER_FILLING_RETURN;
   tr.type_time    = ORDER_TIME_GTC;

   MqlTradeCheckResult chk = {};
   bool called = OrderCheck(tr, chk);
   if (!called && chk.retcode == 0)
      return MakeErr(4001, "OrderCheck call failed");

   string d = KvL("retcode", (long)chk.retcode);
   d = JAdd(d, KvD("margin", chk.margin, 2));
   d = JAdd(d, KvD("margin_free", chk.margin_free, 2));
   d = JAdd(d, KvD("balance", chk.balance, 2));
   d = JAdd(d, KvD("equity", chk.equity, 2));
   d = JAdd(d, KvS("comment", chk.comment));

   if (chk.retcode == 0) return MakeOk(JObj(d));
   return MakeErr((int)chk.retcode, chk.comment, JObj(d));
}

// ---------------------------------------------------------------------------
// Action: ORDER_SEND
// ---------------------------------------------------------------------------

Reply HandleOrderSend(CJAVal &req)
{
   Reply err;

   // Field validation (4001)
   string typeText = FieldStr(req, "order_type");
   ENUM_ORDER_TYPE otype = ORDER_TYPE_BUY;
   if (!ParseOrderType(typeText, otype)) return MakeErr(4001, "unknown order_type: " + typeText);
   if (!req.HasKey("volume")) return MakeErr(4001, "volume required");

   bool isMarket = IsMarketType(otype);
   bool buySide  = IsBuySide(otype);

   string sym        = FieldStr(req, "symbol");
   if (sym == "") sym = g_symbol;
   double volume     = FieldDbl(req, "volume");
   double price      = FieldDbl(req, "price");
   double sl         = FieldDbl(req, "sl");
   double tp         = FieldDbl(req, "tp");
   string comment    = FieldStr(req, "comment");
   long   expiration = FieldLong(req, "expiration");
   long   deviation  = FieldLong(req, "deviation");
   if (deviation <= 0) deviation = InpDeviation;

   if (!isMarket && price <= 0)
      return MakeErr(4001, "price required for " + typeText);
   if (expiration < 0)
      return MakeErr(4001, "expiration must be >= 0");
   if (!isMarket && expiration > 0 && expiration <= TimeCurrent())
      return MakeErr(4001, "expiration is not in the future (server time)");

   // Trading availability (5001 / 5002), then ownership (5010), symbol (5007)
   if (!GateTrading(err)) return err;
   if (req.HasKey("magic") && FieldLong(req, "magic") != InpMagicNumber)
      return MakeErr(5010, "request magic does not equal EA magic");
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);

   int digits = DigitsOf(sym);

   // Duplicate guard: a matching comment means this signal was already executed.
   if (comment != "")
   {
      Reply dup;
      if (FindDuplicate(comment, dup))
      {
         Print("[Bridge] ORDER_SEND duplicate comment, not sent");
         return dup;
      }
   }

   // Symbol mode (5003), volume (5004), prices and stops (5005)
   if (!SymbolModeAllows(sym, true, buySide, err)) return err;
   if (!CheckVolume(sym, volume, err)) return err;

   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double stopRef = 0.0;
   if (isMarket)
   {
      price   = NormalizeDouble(buySide ? ask : bid, digits);
      stopRef = buySide ? bid : ask;   // BUY positions compare with Bid, SELL with Ask
      if (stopRef <= 0 || price <= 0) return MakeErr(10018, "market closed: no quote for " + sym);
   }
   else
   {
      price   = NormalizeDouble(price, digits);
      stopRef = price;
   }
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   if (!CheckStops(sym, buySide, stopRef, sl, tp, true, true, err)) return err;

   // Expiration: only pending orders, only when the symbol allows ORDER_TIME_SPECIFIED
   bool expRequested = (expiration > 0);
   bool expApplied   = false;
   datetime expTime  = 0;
   if (expRequested && !isMarket)
   {
      long emode = SymbolInfoInteger(sym, SYMBOL_EXPIRATION_MODE);
      if ((emode & SYMBOL_EXPIRATION_SPECIFIED) != 0)
      {
         expApplied = true;
         expTime    = (datetime)expiration;
      }
   }

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetDeviationInPoints((ulong)deviation);
   g_trade.SetAsyncMode(false);
   g_trade.SetTypeFilling(isMarket ? MarketFillingMode(sym) : ORDER_FILLING_RETURN);

   if (isMarket)
   {
      if (buySide) g_trade.Buy(volume, sym, price, sl, tp, comment);
      else         g_trade.Sell(volume, sym, price, sl, tp, comment);
   }
   else
   {
      ENUM_ORDER_TYPE_TIME timeType = expApplied ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC;
      switch (otype)
      {
         case ORDER_TYPE_BUY_LIMIT:
            g_trade.BuyLimit(volume, price, sym, sl, tp, timeType, expTime, comment);
            break;
         case ORDER_TYPE_SELL_LIMIT:
            g_trade.SellLimit(volume, price, sym, sl, tp, timeType, expTime, comment);
            break;
         case ORDER_TYPE_BUY_STOP:
            g_trade.BuyStop(volume, price, sym, sl, tp, timeType, expTime, comment);
            break;
         default:
            g_trade.SellStop(volume, price, sym, sl, tp, timeType, expTime, comment);
            break;
      }
   }

   uint rc = g_trade.ResultRetcode();
   if (!IsBrokerSuccess(rc))
   {
      Print("[Bridge] ORDER_SEND rejected type=", typeText, " retcode=", rc);
      return BrokerFailure();
   }

   ulong  order     = g_trade.ResultOrder();
   ulong  deal      = g_trade.ResultDeal();
   double resPrice  = g_trade.ResultPrice();
   double resVolume = g_trade.ResultVolume();
   if (resPrice <= 0)  resPrice  = price;
   if (resVolume <= 0) resVolume = volume;
   long position = (deal > 0) ? PositionFromDeal(deal) : 0;

   string body = OrderResultBody((long)rc, order, deal, position, resPrice, resVolume, digits, false, "");
   if (expRequested) body = JAdd(body, KvB("expiration_applied", expApplied));

   Print("[Bridge] ORDER_SEND ok type=", typeText, " order=", order, " deal=", deal, " position=", position);
   return MakeOk(JObj(body));
}

// ---------------------------------------------------------------------------
// Action: POSITION_MODIFY (also ORDER_MODIFY alias)
// ---------------------------------------------------------------------------

Reply HandlePositionModify(CJAVal &req)
{
   Reply err;
   if (!req.HasKey("ticket")) return MakeErr(4001, "ticket required");
   ulong ticket = (ulong)FieldLong(req, "ticket");

   if (!GateTrading(err)) return err;
   if (!PositionSelectByTicket(ticket))
      return MakeErr(5008, "position not found: " + IntegerToString((long)ticket));
   if (PositionGetInteger(POSITION_MAGIC) != InpMagicNumber)
      return MakeErr(5006, "position not owned by this EA");

   string sym   = PositionGetString(POSITION_SYMBOL);
   bool   buySide = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);
   if (!SymbolModeAllows(sym, false, buySide, err)) return err;

   int    digits = DigitsOf(sym);
   double curSl  = NormalizeDouble(PositionGetDouble(POSITION_SL), digits);
   double curTp  = NormalizeDouble(PositionGetDouble(POSITION_TP), digits);
   double sl     = req.HasKey("sl") ? NormalizeDouble(FieldDbl(req, "sl"), digits) : curSl;
   double tp     = req.HasKey("tp") ? NormalizeDouble(FieldDbl(req, "tp"), digits) : curTp;
   bool   slChanged = (sl != curSl);
   bool   tpChanged = (tp != curTp);

   if (!slChanged && !tpChanged)
   {
      string same = KvL("ticket", (long)ticket);
      same = JAdd(same, KvL("retcode", 0));
      same = JAdd(same, KvD("sl", sl, digits));
      same = JAdd(same, KvD("tp", tp, digits));
      same = JAdd(same, KvB("unchanged", true));
      return MakeOk(JObj(same));
   }

   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double stopRef = buySide ? bid : ask;   // BUY compares with Bid, SELL with Ask
   if (stopRef <= 0) return MakeErr(10018, "market closed: no quote for " + sym);

   if (!CheckStops(sym, buySide, stopRef, sl, tp, slChanged, tpChanged, err)) return err;
   if (slChanged && !CheckFreeze(sym, stopRef, curSl, err)) return err;
   if (tpChanged && !CheckFreeze(sym, stopRef, curTp, err)) return err;

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetAsyncMode(false);
   g_trade.PositionModify(ticket, sl, tp);

   uint rc = g_trade.ResultRetcode();
   if (!IsBrokerSuccess(rc))
   {
      Print("[Bridge] POSITION_MODIFY rejected ticket=", ticket, " retcode=", rc);
      return BrokerFailure();
   }

   Print("[Bridge] POSITION_MODIFY ok ticket=", ticket);
   string d = KvL("ticket", (long)ticket);
   d = JAdd(d, KvL("retcode", (long)rc));
   d = JAdd(d, KvD("sl", sl, digits));
   d = JAdd(d, KvD("tp", tp, digits));
   d = JAdd(d, KvB("unchanged", false));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Action: PENDING_MODIFY
// ---------------------------------------------------------------------------

Reply HandlePendingModify(CJAVal &req)
{
   Reply err;
   if (!req.HasKey("ticket")) return MakeErr(4001, "ticket required");
   ulong ticket = (ulong)FieldLong(req, "ticket");

   if (!GateTrading(err)) return err;
   if (!OrderSelect(ticket))
      return MakeErr(5008, "order not found: " + IntegerToString((long)ticket));
   if (OrderGetInteger(ORDER_MAGIC) != InpMagicNumber)
      return MakeErr(5006, "order not owned by this EA");

   ENUM_ORDER_TYPE otype = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
   if (IsMarketType(otype)) return MakeErr(5008, "ticket is not a pending order");

   string sym     = OrderGetString(ORDER_SYMBOL);
   bool   buySide = IsBuySide(otype);
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);
   if (!SymbolModeAllows(sym, false, buySide, err)) return err;

   int    digits   = DigitsOf(sym);
   double curPrice = NormalizeDouble(OrderGetDouble(ORDER_PRICE_OPEN), digits);
   double curSl    = NormalizeDouble(OrderGetDouble(ORDER_SL), digits);
   double curTp    = NormalizeDouble(OrderGetDouble(ORDER_TP), digits);

   double price = curPrice;
   if (req.HasKey("price") && FieldDbl(req, "price") > 0) price = NormalizeDouble(FieldDbl(req, "price"), digits);
   double sl = req.HasKey("sl") ? NormalizeDouble(FieldDbl(req, "sl"), digits) : curSl;
   double tp = req.HasKey("tp") ? NormalizeDouble(FieldDbl(req, "tp"), digits) : curTp;

   bool priceChanged = (price != curPrice);
   bool slChanged    = (sl != curSl);
   bool tpChanged    = (tp != curTp);

   if (!priceChanged && !slChanged && !tpChanged)
   {
      string same = KvL("ticket", (long)ticket);
      same = JAdd(same, KvL("retcode", 0));
      same = JAdd(same, KvD("price", price, digits));
      same = JAdd(same, KvD("sl", sl, digits));
      same = JAdd(same, KvD("tp", tp, digits));
      same = JAdd(same, KvB("unchanged", true));
      return MakeOk(JObj(same));
   }

   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double market = buySide ? ask : bid;
   if (market <= 0) return MakeErr(10018, "market closed: no quote for " + sym);

   // Side and stops level are measured from the (new) pending price.
   if (!CheckStops(sym, buySide, price, sl, tp, slChanged, tpChanged, err)) return err;
   if (priceChanged && !CheckFreeze(sym, market, curPrice, err)) return err;

   ENUM_ORDER_TYPE_TIME timeType = (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   datetime expiration = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetAsyncMode(false);
   g_trade.OrderModify(ticket, price, sl, tp, timeType, expiration, 0.0);

   uint rc = g_trade.ResultRetcode();
   if (!IsBrokerSuccess(rc))
   {
      Print("[Bridge] PENDING_MODIFY rejected ticket=", ticket, " retcode=", rc);
      return BrokerFailure();
   }

   Print("[Bridge] PENDING_MODIFY ok ticket=", ticket);
   string d = KvL("ticket", (long)ticket);
   d = JAdd(d, KvL("retcode", (long)rc));
   d = JAdd(d, KvD("price", price, digits));
   d = JAdd(d, KvD("sl", sl, digits));
   d = JAdd(d, KvD("tp", tp, digits));
   d = JAdd(d, KvB("unchanged", false));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Action: CLOSE_POSITION (full, or partial when volume is given)
// ---------------------------------------------------------------------------

Reply HandleClosePosition(CJAVal &req)
{
   Reply err;
   if (!req.HasKey("ticket")) return MakeErr(4001, "ticket required");
   ulong ticket = (ulong)FieldLong(req, "ticket");
   double want  = FieldDbl(req, "volume");   // absent or 0 = full close
   if (want < 0) return MakeErr(4001, "volume must be >= 0");

   if (!GateTrading(err)) return err;
   if (!PositionSelectByTicket(ticket))
      return MakeErr(5008, "position not found: " + IntegerToString((long)ticket));
   if (PositionGetInteger(POSITION_MAGIC) != InpMagicNumber)
      return MakeErr(5006, "position not owned by this EA");

   string sym     = PositionGetString(POSITION_SYMBOL);
   bool   buySide = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double posVol  = PositionGetDouble(POSITION_VOLUME);
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);
   if (!SymbolModeAllows(sym, false, buySide, err)) return err;

   bool full = (want <= 0.0) || (MathAbs(want - posVol) < VOLUME_EPS);
   if (!full)
   {
      if (want > posVol + VOLUME_EPS)
         return MakeErr(5004, "volume " + DoubleToString(want, 8) + " exceeds position volume " + DoubleToString(posVol, 8));
      if (!CheckVolume(sym, want, err)) return err;
      double vmin      = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
      double remaining = posVol - want;
      if (remaining < vmin - VOLUME_EPS)
         return MakeErr(5004, "remaining volume " + DoubleToString(remaining, 8) + " would be below min " + DoubleToString(vmin, 8));
   }

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetDeviationInPoints((ulong)InpDeviation);
   g_trade.SetAsyncMode(false);
   g_trade.SetTypeFilling(MarketFillingMode(sym));

   if (full) g_trade.PositionClose(ticket);
   else      g_trade.PositionClosePartial(ticket, want);

   uint rc = g_trade.ResultRetcode();
   if (!IsBrokerSuccess(rc))
   {
      Print("[Bridge] CLOSE_POSITION rejected ticket=", ticket, " retcode=", rc);
      return BrokerFailure();
   }

   double price      = g_trade.ResultPrice();
   double closedVol  = g_trade.ResultVolume();
   if (closedVol <= 0) closedVol = full ? posVol : want;
   ulong  deal       = g_trade.ResultDeal();

   double remaining = 0.0;
   if (PositionSelectByTicket(ticket)) remaining = PositionGetDouble(POSITION_VOLUME);

   Print("[Bridge] CLOSE_POSITION ok ticket=", ticket, " closed=", closedVol, " remaining=", remaining);
   string d = KvL("ticket", (long)ticket);
   d = JAdd(d, KvL("retcode", (long)rc));
   d = JAdd(d, KvL("deal", (long)deal));
   d = JAdd(d, KvD("closed_volume", closedVol, 8));
   d = JAdd(d, KvD("price", price, DigitsOf(sym)));
   d = JAdd(d, KvD("remaining_volume", remaining, 8));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Action: CANCEL_ORDER
// ---------------------------------------------------------------------------

Reply HandleCancelOrder(CJAVal &req)
{
   Reply err;
   if (!req.HasKey("ticket")) return MakeErr(4001, "ticket required");
   ulong ticket = (ulong)FieldLong(req, "ticket");

   if (!GateTrading(err)) return err;
   if (!OrderSelect(ticket))
      return MakeErr(5008, "order not found: " + IntegerToString((long)ticket));
   if (OrderGetInteger(ORDER_MAGIC) != InpMagicNumber)
      return MakeErr(5006, "order not owned by this EA");

   ENUM_ORDER_TYPE otype = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
   if (IsMarketType(otype)) return MakeErr(5008, "ticket is not a pending order");

   string sym = OrderGetString(ORDER_SYMBOL);
   if (!SymbolUsable(sym)) return MakeErr(5007, "unknown symbol: " + sym);
   if (!SymbolModeAllows(sym, false, IsBuySide(otype), err)) return err;

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetAsyncMode(false);
   g_trade.OrderDelete(ticket);

   uint rc = g_trade.ResultRetcode();
   if (!IsBrokerSuccess(rc))
   {
      Print("[Bridge] CANCEL_ORDER rejected ticket=", ticket, " retcode=", rc);
      return BrokerFailure();
   }

   Print("[Bridge] CANCEL_ORDER ok ticket=", ticket);
   string d = KvL("ticket", (long)ticket);
   d = JAdd(d, KvL("retcode", (long)rc));
   return MakeOk(JObj(d));
}

// ---------------------------------------------------------------------------
// Dispatch, replay cache and request pump
// ---------------------------------------------------------------------------

Reply Dispatch(string action, CJAVal &req)
{
   if (action == "PING")            return HandlePing();
   if (action == "ACCOUNT_INFO")    return HandleAccountInfo();
   if (action == "SYMBOL_INFO")     return HandleSymbolInfo(req);
   if (action == "GET_POSITIONS")   return HandleGetPositions(req);
   if (action == "GET_ORDERS")      return HandleGetOrders(req);
   if (action == "GET_DEALS")       return HandleGetDeals(req);
   if (action == "ORDER_CHECK")     return HandleOrderCheck(req);
   if (action == "ORDER_SEND")      return HandleOrderSend(req);
   if (action == "POSITION_MODIFY") return HandlePositionModify(req);
   if (action == "ORDER_MODIFY")    return HandlePositionModify(req);
   if (action == "PENDING_MODIFY")  return HandlePendingModify(req);
   if (action == "CLOSE_POSITION")  return HandleClosePosition(req);
   if (action == "CANCEL_ORDER")    return HandleCancelOrder(req);
   return MakeErr(4001, "unknown action: " + action);
}

int FindCached(string request_id)
{
   for (int i = 0; i < g_cache_count; i++)
      if (g_cache[i].request_id == request_id) return i;
   return -1;
}

void CacheReply(string request_id, Reply &r)
{
   if (request_id == "") return;
   g_cache[g_cache_next].request_id = request_id;
   g_cache[g_cache_next].reply      = r;
   g_cache_next = (g_cache_next + 1) % REPLAY_CACHE_SIZE;
   if (g_cache_count < REPLAY_CACHE_SIZE) g_cache_count++;
}

// Parses one request and returns the reply text. Always returns a reply.
string HandleRaw(string raw)
{
   CJAVal req;
   if (!req.Deserialize(raw) || req.type != jtOBJ)
   {
      Print("[Bridge] rejected: malformed JSON request");
      Reply bad = MakeErr(4001, "malformed JSON request");
      return BuildResponse("", bad, false);
   }

   string request_id = FieldStr(req, "request_id");

   if (!req.HasKey("v") || FieldLong(req, "v") != PROTOCOL_VERSION)
   {
      Print("[Bridge] rejected: unsupported protocol version");
      Reply badVersion = MakeErr(4001, "missing or unsupported protocol version v (expected 2)");
      return BuildResponse(request_id, badVersion, false);
   }

   string action = FieldStr(req, "action");
   if (action == "")
   {
      Reply noAction = MakeErr(4001, "action required");
      return BuildResponse(request_id, noAction, false);
   }

   bool mutating = IsMutatingAction(action);
   if (mutating && request_id != "")
   {
      int idx = FindCached(request_id);
      if (idx >= 0)
      {
         Reply cached = g_cache[idx].reply;
         Print("[Bridge] ", action, " replayed request_id=", request_id);
         return BuildResponse(request_id, cached, true);
      }
   }

   Reply r;
   if (mutating)
   {
      long expiresAt = FieldLong(req, "expires_at");
      if (!req.HasKey("expires_at") || expiresAt <= 0)
         r = MakeErr(4001, "expires_at required for " + action);
      else if ((long)TimeGMT() > expiresAt)
         r = MakeErr(5009, "request expired");
      else
         r = Dispatch(action, req);
      CacheReply(request_id, r);
   }
   else
   {
      r = Dispatch(action, req);
   }

   Print("[Bridge] ", action, " request_id=", request_id, " ok=", r.ok, " retcode=", r.retcode);
   return BuildResponse(request_id, r, false);
}

// Drains up to MAX_PER_PASS queued requests. Each receive is followed by
// exactly one send, which keeps the REP socket in strict alternation.
void ProcessRequests()
{
   if (g_socket == NULL) return;

   for (int n = 0; n < MAX_PER_PASS; n++)
   {
      ZmqMsg request;
      if (!g_socket.recv(request, true)) break;   // ZMQ_DONTWAIT: nothing queued

      string response = HandleRaw(request.getData());
      ZmqMsg reply(response);
      if (!g_socket.send(reply)) Print("[Bridge] WARNING: reply send failed");
   }
}

void CloseSocket()
{
   if (g_socket != NULL)
   {
      g_socket.unbind(InpEndpoint);
      delete g_socket;
      g_socket = NULL;
   }
   if (g_ctx != NULL)
   {
      delete g_ctx;
      g_ctx = NULL;
   }
}

// ---------------------------------------------------------------------------
// EA lifecycle
// ---------------------------------------------------------------------------

int OnInit()
{
   g_symbol = ResolveSymbol("XAUUSD");
   Print("[Bridge] Resolved symbol: ", g_symbol);

   g_trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   g_trade.SetDeviationInPoints((ulong)InpDeviation);
   g_trade.SetAsyncMode(false);

   g_ctx    = new Context("VantageBridge");
   g_socket = new Socket(g_ctx, ZMQ_REP);
   g_socket.setReceiveHighWaterMark(10);
   g_socket.setSendHighWaterMark(10);
   g_socket.setLinger(0);

   if (!g_socket.bind(InpEndpoint))
   {
      Print("[Bridge] FATAL: cannot bind ", InpEndpoint);
      CloseSocket();
      return INIT_FAILED;
   }

   int period = (InpPollIntervalMs < 10) ? 10 : InpPollIntervalMs;
   if (!EventSetMillisecondTimer(period))
   {
      Print("[Bridge] FATAL: cannot set timer to ", period, " ms");
      CloseSocket();
      return INIT_FAILED;
   }

   Print("[Bridge] v", EA_VERSION, " listening on ", InpEndpoint, " magic=", InpMagicNumber,
         " poll=", period, "ms");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   CloseSocket();
   Print("[Bridge] Shutdown. Reason=", reason);
}

void OnTimer()
{
   ProcessRequests();
}

void OnTick()
{
   ProcessRequests();
}
