#!/usr/bin/env python3
"""
ProphetMM — Hummingbot PMM (Pure Market Making) script for OpenProphet.
Uses custom spread/order sizing logic tuned for Coinbase.

Drop this into hummingbot_workspace/scripts/ then run via:
  start --script prophet_mm.py
"""
from decimal import Decimal
from hummingbot.strategy.script_strategy_base import ScriptStrategyBase


class ProphetMM(ScriptStrategyBase):
    """
    Pure Market Making with dynamic spread based on volatility.
    Targets BTC/USDT on Coinbase with Coinbase-realistic fees.
    """
    # Config
    exchange = "coinbase"
    trading_pair = "BTC-USDT"
    order_amount = Decimal("0.001")  # ~$85 per side at $85k BTC
    
    # Spread parameters
    bid_spread = Decimal("0.002")   # 0.2% below mid
    ask_spread = Decimal("0.002")   # 0.2% above mid
    order_refresh_time = 30         # seconds
    
    # Risk limits
    max_order_age = 120             # cancel stale orders after 2 min
    inventory_target_base_pct = Decimal("0.5")  # target 50/50 balance
    inventory_range_multiplier = Decimal("2.0")  # widen spread when imbalanced
    
    # Minimum profitability (must exceed Coinbase taker fee ~0.2%)
    min_profitability = Decimal("0.003")  # 0.3% minimum spread
    
    markets = {"coinbase": {"BTC-USDT"}}
    
    def on_tick(self):
        """Called every tick — manage orders."""
        # Cancel existing orders
        for order in self.get_active_orders(connector_name=self.exchange):
            if self.current_timestamp - order.creation_timestamp > self.max_order_age:
                self.cancel(self.exchange, order.trading_pair, order.client_order_id)
        
        # Check if we need to place new orders
        if len(self.get_active_orders(connector_name=self.exchange)) < 2:
            self.place_orders()
    
    def place_orders(self):
        """Place bid and ask orders around mid price."""
        mid_price = self.connectors[self.exchange].get_mid_price(self.trading_pair)
        if mid_price is None or mid_price <= 0:
            return
        
        # Adjust spreads based on inventory
        inventory_ratio = self.get_inventory_ratio()
        bid_adj, ask_adj = self.adjust_spreads_for_inventory(inventory_ratio)
        
        # Ensure minimum profitability
        effective_bid = max(self.bid_spread + bid_adj, self.min_profitability / 2)
        effective_ask = max(self.ask_spread + ask_adj, self.min_profitability / 2)
        
        bid_price = mid_price * (Decimal("1") - effective_bid)
        ask_price = mid_price * (Decimal("1") + effective_ask)
        
        # Place orders
        self.buy(self.exchange, self.trading_pair, self.order_amount, bid_price)
        self.sell(self.exchange, self.trading_pair, self.order_amount, ask_price)
        
        self.logger().info(
            f"Orders placed: BID {bid_price:.2f} | ASK {ask_price:.2f} | "
            f"Spread: {(effective_bid + effective_ask) * 100:.2f}% | "
            f"Inventory: {inventory_ratio:.1%}"
        )
    
    def get_inventory_ratio(self) -> Decimal:
        """Get current base asset ratio (0=all quote, 1=all base)."""
        base_bal = self.connectors[self.exchange].get_balance(self.trading_pair.split("-")[0])
        quote_bal = self.connectors[self.exchange].get_balance(self.trading_pair.split("-")[1])
        mid = self.connectors[self.exchange].get_mid_price(self.trading_pair)
        if mid and mid > 0:
            base_value = base_bal * mid
            total = base_value + quote_bal
            if total > 0:
                return base_value / total
        return Decimal("0.5")
    
    def adjust_spreads_for_inventory(self, ratio: Decimal):
        """Widen the side we want to reduce, tighten the side we want to add."""
        deviation = ratio - self.inventory_target_base_pct
        adjustment = deviation * self.inventory_range_multiplier * self.bid_spread
        # If we have too much base (ratio > 0.5), widen ask (sell cheaper), tighten bid
        return (-adjustment, adjustment)
