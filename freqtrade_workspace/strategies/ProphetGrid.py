"""
ProphetGrid — Freqtrade strategy mirroring OpenProphet's crypto-grid preset.

Range-bound grid trading. Buys dips, sells bounces within Bollinger Band range.
Uses mean-reversion signals in consolidation regimes.
"""
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter
from pandas import DataFrame
import talib.abstract as ta
import numpy as np


class ProphetGrid(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"

    # Conservative ROI for grid-style exits
    minimal_roi = {"0": 0.02, "60": 0.015, "120": 0.01, "240": 0.005}
    stoploss = -0.03
    trailing_stop = True
    trailing_stop_positive = 0.005
    trailing_stop_positive_offset = 0.01
    trailing_only_offset_is_reached = True

    # Allow multiple entries to simulate grid levels
    position_adjustment_enable = True
    max_entry_position_adjustment = 3

    # Parameters
    bb_period = IntParameter(15, 30, default=20, space="buy")
    bb_std = DecimalParameter(1.5, 2.5, default=2.0, decimals=1, space="buy")
    rsi_buy = IntParameter(20, 40, default=35, space="buy")
    rsi_sell = IntParameter(60, 80, default=65, space="sell")
    adx_threshold = IntParameter(15, 30, default=25, space="buy")

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # Bollinger Bands
        bb = ta.BBANDS(dataframe, timeperiod=self.bb_period.value,
                       nbdevup=self.bb_std.value, nbdevdn=self.bb_std.value)
        dataframe["bb_lower"] = bb["lowerband"]
        dataframe["bb_upper"] = bb["upperband"]
        dataframe["bb_mid"] = bb["middleband"]
        dataframe["bb_width"] = (dataframe["bb_upper"] - dataframe["bb_lower"]) / dataframe["bb_mid"]

        # RSI
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)

        # ADX — low ADX = range-bound (good for grid)
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)

        # Stochastic
        stoch = ta.STOCH(dataframe, fastk_period=14, slowk_period=3, slowd_period=3)
        dataframe["slowk"] = stoch["slowk"]
        dataframe["slowd"] = stoch["slowd"]

        # Volume profile
        dataframe["volume_mean"] = dataframe["volume"].rolling(20).mean()

        # Price position within BBands (0 = lower, 1 = upper)
        bb_range = dataframe["bb_upper"] - dataframe["bb_lower"]
        bb_range = bb_range.replace(0, np.nan)
        dataframe["bb_position"] = (dataframe["close"] - dataframe["bb_lower"]) / bb_range

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                # Price near lower Bollinger Band (grid buy zone)
                (dataframe["bb_position"] < 0.2)
                & (dataframe["rsi"] < self.rsi_buy.value)
                # Range-bound market (low ADX)
                & (dataframe["adx"] < self.adx_threshold.value)
                # Volume confirmation
                & (dataframe["volume"] > dataframe["volume_mean"] * 0.8)
                # Stochastic oversold
                & (dataframe["slowk"] < 30)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                # Price near upper Bollinger Band (grid sell zone)
                (dataframe["bb_position"] > 0.8)
                & (dataframe["rsi"] > self.rsi_sell.value)
            )
            | (
                # Breakout detected — exit grid
                (dataframe["adx"] > 40)
                & (dataframe["bb_width"] > dataframe["bb_width"].rolling(50).mean() * 1.5)
            ),
            "exit_long",
        ] = 1
        return dataframe

    def adjust_entry_price(self, trade, order, pair, current_time, proposed_rate,
                           current_order_rate, entry_tag, side, **kwargs):
        return proposed_rate

    def adjust_trade_position(self, trade, current_time, current_rate, current_profit,
                              min_stake, max_stake, current_entry_rate, current_exit_rate,
                              current_entry_profit, current_exit_profit, **kwargs):
        """Grid-style DCA: add to position at each grid level below entry."""
        if current_profit > -0.01:
            return None
        # Add at -1%, -2%, -3% grid levels
        filled_entries = trade.nr_of_successful_entries
        if filled_entries >= 4:
            return None
        grid_level = filled_entries * 0.01
        if current_profit <= -(grid_level + 0.01):
            return min_stake
        return None
