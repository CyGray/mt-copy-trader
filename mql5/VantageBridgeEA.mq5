//+------------------------------------------------------------------+
//|  VantageBridgeEA.mq5                                             |
//|  ByTrader MT5 Bridge — ZeroMQ REP Server                         |
//|                                                                    |
//|  Listens on tcp://127.0.0.1:5555 for JSON commands from the      |
//|  Node.js worker and executes them against the Vantage XAUUSD     |
//|  market via the standard CTrade API.                              |
//|                                                                    |
//|  Supported actions:                                               |
//|    ORDER_SEND    — place market or pending order                  |
//|    ORDER_MODIFY  — amend SL/TP on an open position               |
//|    GET_POSITIONS — return all open positions for a symbol         |
//|    CLOSE_POSITION — close a specific position by ticket          |
//|                                                                    |
//|  Prerequisites (place in MT5/MQL5/Libraries/):                   |
//|    libzmq.dll  — ZeroMQ 4.x Windows DLL                          |
//|    Mql5Zmq.dll — MQL5 ZeroMQ wrapper (github/dingmaotu/mql5-zmq) |
//|  And in MT5/MQL5/Include/:                                        |
//|    Zmq/         — mql5-zmq header files                          |
//|    JAson.mqh    — JSON library (bundled in this repo)             |
//+------------------------------------------------------------------+

#property copyright "ByTrader"
#property version   "1.0"
#property strict

#include <Zmq/Zmq.mqh>
#include <JAson.mqh>
#include <Trade/Trade.mqh>

// ---------------------------------------------------------------------------
// Input parameters
// ---------------------------------------------------------------------------

input string InpEndpoint     = "tcp://127.0.0.1:5555"; // ZeroMQ bind address
input int    InpMagicNumber  = 98801;                  // Magic number for all orders
input int    InpDeviation    = 20;                     // Max slippage in points
input int    InpPollIntervalMs = 5;                    // Socket poll interval (ms)
input bool   InpAutoSuffix   = true;                   // Auto-detect symbol suffix

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

Context  *g_ctx    = NULL;
Socket   *g_socket = NULL;
CTrade    g_trade;
string    g_symbol;  // Resolved symbol with broker suffix (e.g. "XAUUSD+")

// ---------------------------------------------------------------------------
// Symbol resolution — auto-detect broker suffix
// ---------------------------------------------------------------------------

string ResolveSymbol(string base)
{
   if (!InpAutoSuffix) return base;

   // Try common suffixes in order
   string suffixes[] = {"", "+", ".raw", ".Raw", "m", "pro"};
   for (int i = 0; i < ArraySize(suffixes); i++)
   {
      string candidate = base + suffixes[i];
      if (SymbolSelect(candidate, true) && SymbolInfoDouble(candidate, SYMBOL_BID) > 0)
         return candidate;
   }
   Print("[Bridge] WARNING: Could not resolve symbol for base '", base, "'. Using base as-is.");
   return base;
}

// ---------------------------------------------------------------------------
// Stop-level pre-flight check (prevents error 10016 on Vantage)
// ---------------------------------------------------------------------------

bool ValidateStops(string symbol, double price, double sl, double tp, string type)
{
   long stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double point    = SymbolInfoDouble(symbol,  SYMBOL_POINT);
   double minDist  = stopsLevel * point;

   bool buying = (StringFind(type, "BUY") >= 0);

   if (sl > 0 && MathAbs(price - sl) < minDist)
   {
      Print("[Bridge] SL too close: dist=", MathAbs(price - sl), " minDist=", minDist);
      return false;
   }
   if (tp > 0 && MathAbs(price - tp) < minDist)
   {
      Print("[Bridge] TP too close: dist=", MathAbs(price - tp), " minDist=", minDist);
      return false;
   }
   return true;
}

// ---------------------------------------------------------------------------
// JSON response builders
// ---------------------------------------------------------------------------

string OkResponse(CJAVal &data)
{
   CJAVal resp;
   resp["ok"]      = true;
   resp["retcode"] = (long)0;
   resp["data"]    = data;
   return resp.Serialize();
}

string ErrorResponse(int retcode, string message)
{
   CJAVal resp;
   resp["ok"]      = false;
   resp["retcode"] = (long)retcode;
   resp["error"]   = message;
   return resp.Serialize();
}

// ---------------------------------------------------------------------------
// Action: ORDER_SEND
// ---------------------------------------------------------------------------

string HandleOrderSend(CJAVal &req)
{
   string symbol    = req["symbol"].ToStr();
   if (symbol == "") symbol = g_symbol;

   string typeStr   = req["order_type"].ToStr();
   double volume    = req["volume"].ToDbl();
   double price     = req["price"].ToDbl();
   double sl        = req["sl"].ToDbl();
   double tp        = req["tp"].ToDbl();
   int    deviation = (int)req["deviation"].ToInt();
   string comment   = req["comment"].ToStr();
   int    magic     = (int)req["magic"].ToInt();
   if (magic == 0) magic = InpMagicNumber;
   if (deviation == 0) deviation = InpDeviation;

   g_trade.SetExpertMagicNumber(magic);
   g_trade.SetDeviationInPoints(deviation);
   g_trade.SetTypeFilling(ORDER_FILLING_IOC);

   // Determine current price for market orders
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);

   bool ok = false;
   ulong ticket = 0;

   if (typeStr == "BUY")
   {
      if (!ValidateStops(symbol, ask, sl, tp, "BUY"))
         return ErrorResponse(10016, "SL/TP too close to market for BUY");
      ok = g_trade.Buy(volume, symbol, ask, sl, tp, comment);
   }
   else if (typeStr == "SELL")
   {
      if (!ValidateStops(symbol, bid, sl, tp, "SELL"))
         return ErrorResponse(10016, "SL/TP too close to market for SELL");
      ok = g_trade.Sell(volume, symbol, bid, sl, tp, comment);
   }
   else if (typeStr == "BUY_LIMIT")
   {
      if (price <= 0) return ErrorResponse(4001, "price required for BUY_LIMIT");
      if (!ValidateStops(symbol, price, sl, tp, "BUY_LIMIT"))
         return ErrorResponse(10016, "SL/TP too close for BUY_LIMIT");
      ok = g_trade.BuyLimit(volume, price, symbol, sl, tp, 0, 0, comment);
   }
   else if (typeStr == "SELL_LIMIT")
   {
      if (price <= 0) return ErrorResponse(4001, "price required for SELL_LIMIT");
      if (!ValidateStops(symbol, price, sl, tp, "SELL_LIMIT"))
         return ErrorResponse(10016, "SL/TP too close for SELL_LIMIT");
      ok = g_trade.SellLimit(volume, price, symbol, sl, tp, 0, 0, comment);
   }
   else if (typeStr == "BUY_STOP")
   {
      if (price <= 0) return ErrorResponse(4001, "price required for BUY_STOP");
      ok = g_trade.BuyStop(volume, price, symbol, sl, tp, 0, 0, comment);
   }
   else if (typeStr == "SELL_STOP")
   {
      if (price <= 0) return ErrorResponse(4001, "price required for SELL_STOP");
      ok = g_trade.SellStop(volume, price, symbol, sl, tp, 0, 0, comment);
   }
   else
   {
      return ErrorResponse(4001, "Unknown order_type: " + typeStr);
   }

   if (!ok)
   {
      int retcode = (int)g_trade.ResultRetcode();
      return ErrorResponse(retcode, g_trade.ResultRetcodeDescription());
   }

   ticket = g_trade.ResultOrder();
   Print("[Bridge] ORDER_SEND ok ticket=", ticket, " type=", typeStr, " vol=", volume);

   CJAVal data;
   data["ticket"] = (long)ticket;
   data["retcode"] = (long)g_trade.ResultRetcode();
   return OkResponse(data);
}

// ---------------------------------------------------------------------------
// Action: ORDER_MODIFY
// ---------------------------------------------------------------------------

string HandleOrderModify(CJAVal &req)
{
   ulong  ticket = (ulong)req["ticket"].ToInt();
   double sl     = req["sl"].ToDbl();
   double tp     = req["tp"].ToDbl();

   if (!PositionSelectByTicket(ticket))
      return ErrorResponse(4001, "Position not found: " + (string)ticket);

   string symbol = PositionGetString(POSITION_SYMBOL);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);

   if (!ValidateStops(symbol, openPrice, sl, tp, "MODIFY"))
      return ErrorResponse(10016, "SL/TP too close for ORDER_MODIFY");

   bool ok = g_trade.PositionModify(ticket, sl, tp);
   if (!ok)
   {
      int retcode = (int)g_trade.ResultRetcode();
      return ErrorResponse(retcode, g_trade.ResultRetcodeDescription());
   }

   Print("[Bridge] ORDER_MODIFY ok ticket=", ticket, " sl=", sl, " tp=", tp);

   CJAVal data;
   data["ticket"]  = (long)ticket;
   data["retcode"] = (long)g_trade.ResultRetcode();
   return OkResponse(data);
}

// ---------------------------------------------------------------------------
// Action: GET_POSITIONS
// ---------------------------------------------------------------------------

string HandleGetPositions(CJAVal &req)
{
   string filterSymbol = req["symbol"].ToStr();

   CJAVal positions;
   int count = 0;

   for (int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      if (filterSymbol != "" && sym != filterSymbol) continue;

      int    posType   = (int)PositionGetInteger(POSITION_TYPE);
      double vol       = PositionGetDouble(POSITION_VOLUME);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl        = PositionGetDouble(POSITION_SL);
      double tp        = PositionGetDouble(POSITION_TP);
      double profit    = PositionGetDouble(POSITION_PROFIT);
      long   magic     = PositionGetInteger(POSITION_MAGIC);
      string posComment = PositionGetString(POSITION_COMMENT);

      CJAVal pos;
      pos["ticket"]     = (long)ticket;
      pos["symbol"]     = sym;
      pos["type"]       = posType == POSITION_TYPE_BUY ? "BUY" : "SELL";
      pos["volume"]     = vol;
      pos["open_price"] = openPrice;
      pos["sl"]         = sl;
      pos["tp"]         = tp;
      pos["profit"]     = profit;
      pos["magic"]      = (long)magic;
      pos["comment"]    = posComment;
      positions[count]  = pos;
      count++;
   }

   CJAVal data;
   data["positions"] = positions;
   data["count"]     = (long)count;
   return OkResponse(data);
}

// ---------------------------------------------------------------------------
// Action: CLOSE_POSITION
// ---------------------------------------------------------------------------

string HandleClosePosition(CJAVal &req)
{
   ulong  ticket = (ulong)req["ticket"].ToInt();
   double volume = req["volume"].ToDbl(); // 0 = full close

   if (!PositionSelectByTicket(ticket))
      return ErrorResponse(4001, "Position not found: " + (string)ticket);

   bool ok;
   if (volume > 0)
      ok = g_trade.PositionClosePartial(ticket, volume);
   else
      ok = g_trade.PositionClose(ticket);

   if (!ok)
   {
      int retcode = (int)g_trade.ResultRetcode();
      return ErrorResponse(retcode, g_trade.ResultRetcodeDescription());
   }

   Print("[Bridge] CLOSE_POSITION ok ticket=", ticket);

   CJAVal data;
   data["ticket"]  = (long)ticket;
   data["retcode"] = (long)g_trade.ResultRetcode();
   return OkResponse(data);
}

// ---------------------------------------------------------------------------
// EA Lifecycle
// ---------------------------------------------------------------------------

int OnInit()
{
   // Resolve broker symbol suffix
   g_symbol = ResolveSymbol("XAUUSD");
   Print("[Bridge] Resolved symbol: ", g_symbol);

   // Initialise ZeroMQ context and REP socket
   g_ctx    = new Context("VantageBridge");
   g_socket = new Socket(g_ctx, ZMQ_REP);

   g_socket.setReceiveHighWaterMark(10);
   g_socket.setSendHighWaterMark(10);
   g_socket.setLinger(0);

   if (!g_socket.bind(InpEndpoint))
   {
      Print("[Bridge] FATAL: Cannot bind to ", InpEndpoint);
      return INIT_FAILED;
   }

   Print("[Bridge] Listening on ", InpEndpoint, " magic=", InpMagicNumber);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
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
   Print("[Bridge] Shutdown. Reason=", reason);
}

void OnTick()
{
   if (g_socket == NULL) return;

   ZmqMsg request;

   // Non-blocking poll
   if (!g_socket.recv(request, ZMQ_DONTWAIT)) return;

   string raw = request.getData();
   Print("[Bridge] RX: ", raw);

   // Parse JSON
   CJAVal req;
   if (!req.Deserialize(raw))
   {
      string err = ErrorResponse(4001, "JSON parse error");
      ZmqMsg reply(err);
      g_socket.send(reply);
      return;
   }

   string action = req["action"].ToStr();
   string response;

   if      (action == "ORDER_SEND")     response = HandleOrderSend(req);
   else if (action == "ORDER_MODIFY")   response = HandleOrderModify(req);
   else if (action == "GET_POSITIONS")  response = HandleGetPositions(req);
   else if (action == "CLOSE_POSITION") response = HandleClosePosition(req);
   else
      response = ErrorResponse(4001, "Unknown action: " + action);

   Print("[Bridge] TX: ", response);
   ZmqMsg reply(response);
   g_socket.send(reply);
}
