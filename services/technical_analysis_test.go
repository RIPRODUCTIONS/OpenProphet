package services

import (
	"math"
	"prophet-trader/interfaces"
	"testing"
	"time"
)

// makeBars creates a slice of bars with the given close prices.
// Volume defaults to 1000, timestamps are sequential daily.
func makeBars(closes ...float64) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, len(closes))
	base := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, c := range closes {
		bars[i] = &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: base.Add(time.Duration(i) * 24 * time.Hour),
			Open:      c,
			High:      c + 1,
			Low:       c - 1,
			Close:     c,
			Volume:    1000,
		}
	}
	return bars
}

// makeBarsWithVolume creates bars with specific close prices and volumes.
func makeBarsWithVolume(data []struct{ Close float64; Volume int64 }) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, len(data))
	base := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, d := range data {
		bars[i] = &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: base.Add(time.Duration(i) * 24 * time.Hour),
			Open:      d.Close,
			High:      d.Close + 1,
			Low:       d.Close - 1,
			Close:     d.Close,
			Volume:    d.Volume,
		}
	}
	return bars
}

func approxEqual(a, b, epsilon float64) bool {
	return math.Abs(a-b) < epsilon
}

// --- CalculateSMA Tests ---

func TestCalculateSMA(t *testing.T) {
	tests := []struct {
		name   string
		bars   []*interfaces.Bar
		period int
		want   float64
	}{
		{
			name:   "basic SMA 3-period",
			bars:   makeBars(10, 20, 30),
			period: 3,
			want:   20.0, // (10+20+30)/3
		},
		{
			name:   "SMA uses last N bars only",
			bars:   makeBars(5, 10, 20, 30, 40),
			period: 3,
			want:   30.0, // (20+30+40)/3
		},
		{
			name:   "SMA with period=1 returns last bar",
			bars:   makeBars(10, 20, 30),
			period: 1,
			want:   30.0,
		},
		{
			name:   "insufficient data returns 0",
			bars:   makeBars(10, 20),
			period: 5,
			want:   0,
		},
		{
			name:   "empty bars returns 0",
			bars:   makeBars(),
			period: 5,
			want:   0,
		},
		{
			name:   "exact period length",
			bars:   makeBars(100, 200, 300, 400, 500),
			period: 5,
			want:   300.0, // (100+200+300+400+500)/5
		},
		{
			name:   "constant prices",
			bars:   makeBars(50, 50, 50, 50, 50),
			period: 3,
			want:   50.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalculateSMA(tt.bars, tt.period)
			if !approxEqual(got, tt.want, 0.001) {
				t.Errorf("CalculateSMA() = %v, want %v", got, tt.want)
			}
		})
	}
}

// --- CalculateRSI Tests ---

func TestCalculateRSI(t *testing.T) {
	tests := []struct {
		name   string
		bars   []*interfaces.Bar
		period int
		want   float64
		eps    float64
	}{
		{
			name:   "all gains → RSI 100",
			bars:   makeBars(10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25),
			period: 14,
			want:   100.0,
			eps:    0.01,
		},
		{
			name:   "all losses → RSI 0",
			bars:   makeBars(25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10),
			period: 14,
			want:   0.0,
			eps:    0.01,
		},
		{
			name:   "equal gains and losses → RSI 50",
			bars:   makeBars(100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100),
			period: 14,
			want:   50.0,
			eps:    0.01,
		},
		{
			name:   "insufficient data → neutral 50",
			bars:   makeBars(10, 20, 30),
			period: 14,
			want:   50.0,
			eps:    0.01,
		},
		{
			name:   "flat prices → RSI 100 (avgLoss==0 short-circuits to 100)",
			bars:   makeBars(50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50),
			period: 14,
			want:   100.0, // avgGain=0, avgLoss=0 → avgLoss==0 check returns 100
			eps:    0.01,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalculateRSI(tt.bars, tt.period)
			if !approxEqual(got, tt.want, tt.eps) {
				t.Errorf("CalculateRSI() = %v, want %v (±%v)", got, tt.want, tt.eps)
			}
		})
	}
}

func TestCalculateRSI_FlatPrices(t *testing.T) {
	// Flat prices: avgGain=0, avgLoss=0 → code returns 100 (because avgLoss==0 short-circuits).
	// This is a known behavior of the implementation — document it.
	bars := makeBars(50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50)
	got := CalculateRSI(bars, 14)
	if got != 100.0 {
		t.Errorf("CalculateRSI(flat) = %v, want 100.0 (avgLoss==0 returns 100)", got)
	}
}

func TestCalculateRSI_MostlyGains(t *testing.T) {
	// 12 gains of +1, 2 losses of -0.5
	prices := []float64{100}
	for i := 0; i < 12; i++ {
		prices = append(prices, prices[len(prices)-1]+1)
	}
	// Add 2 losses
	prices = append(prices, prices[len(prices)-1]-0.5)
	prices = append(prices, prices[len(prices)-1]-0.5)

	bars := makeBars(prices...)
	got := CalculateRSI(bars, 14)

	// RSI should be high (more gains than losses)
	if got <= 50 || got >= 100 {
		t.Errorf("CalculateRSI(mostly gains) = %v, want between 50 and 100", got)
	}
}

// --- CalculateMACD Tests ---

func TestCalculateMACD(t *testing.T) {
	t.Run("insufficient data returns nil", func(t *testing.T) {
		bars := makeBars(1, 2, 3, 4, 5)
		result := CalculateMACD(bars)
		if result != nil {
			t.Errorf("CalculateMACD() = %v, want nil for < 26 bars", result)
		}
	})

	t.Run("returns non-nil with 26+ bars", func(t *testing.T) {
		prices := make([]float64, 30)
		for i := range prices {
			prices[i] = 100 + float64(i)
		}
		bars := makeBars(prices...)

		result := CalculateMACD(bars)
		if result == nil {
			t.Fatal("CalculateMACD() returned nil for 30 bars")
		}
		// Histogram = MACD - Signal
		if !approxEqual(result.Histogram, result.MACD-result.Signal, 0.0001) {
			t.Errorf("Histogram (%v) != MACD (%v) - Signal (%v)", result.Histogram, result.MACD, result.Signal)
		}
	})

	t.Run("uptrend has positive MACD", func(t *testing.T) {
		// Strong uptrend: 12-EMA > 26-EMA → positive MACD line
		prices := make([]float64, 50)
		for i := range prices {
			prices[i] = 100 + float64(i)*2
		}
		bars := makeBars(prices...)
		result := CalculateMACD(bars)
		if result == nil {
			t.Fatal("CalculateMACD() returned nil")
		}
		if result.MACD <= 0 {
			t.Errorf("CalculateMACD() MACD line = %v, want positive for uptrend", result.MACD)
		}
	})

	t.Run("downtrend has negative MACD", func(t *testing.T) {
		// Strong downtrend: 12-EMA < 26-EMA → negative MACD line
		prices := make([]float64, 50)
		for i := range prices {
			prices[i] = 200 - float64(i)*2
		}
		bars := makeBars(prices...)
		result := CalculateMACD(bars)
		if result == nil {
			t.Fatal("CalculateMACD() returned nil")
		}
		if result.MACD >= 0 {
			t.Errorf("CalculateMACD() MACD line = %v, want negative for downtrend", result.MACD)
		}
	})

	t.Run("exactly 26 bars", func(t *testing.T) {
		prices := make([]float64, 26)
		for i := range prices {
			prices[i] = float64(100 + i)
		}
		bars := makeBars(prices...)
		result := CalculateMACD(bars)
		if result == nil {
			t.Error("CalculateMACD() returned nil for exactly 26 bars")
		}
	})
}

// --- calculateEMA Tests ---

func TestCalculateEMA(t *testing.T) {
	t.Run("insufficient data returns last close", func(t *testing.T) {
		bars := makeBars(10, 20, 30)
		got := calculateEMA(bars, 10)
		if got != 30.0 {
			t.Errorf("calculateEMA() = %v, want 30 (last close)", got)
		}
	})

	t.Run("EMA with exact period equals SMA", func(t *testing.T) {
		bars := makeBars(10, 20, 30, 40, 50)
		// With exactly 5 bars and period 5, EMA starts as SMA with no additional bars
		got := calculateEMA(bars, 5)
		sma := CalculateSMA(bars, 5)
		if !approxEqual(got, sma, 0.001) {
			t.Errorf("calculateEMA(period=len) = %v, want SMA = %v", got, sma)
		}
	})

	t.Run("EMA tracks recent prices more", func(t *testing.T) {
		// Prices jump from 100 to 200 at the end — EMA should be > SMA
		prices := make([]float64, 20)
		for i := 0; i < 15; i++ {
			prices[i] = 100
		}
		for i := 15; i < 20; i++ {
			prices[i] = 200
		}
		bars := makeBars(prices...)
		ema := calculateEMA(bars, 10)
		sma := CalculateSMA(bars, 10)
		if ema <= sma {
			t.Errorf("EMA (%v) should be > SMA (%v) when prices jump up recently", ema, sma)
		}
	})
}

// --- calculateMomentum Tests ---

func TestCalculateMomentum(t *testing.T) {
	t.Run("insufficient data returns nil", func(t *testing.T) {
		bars := makeBars(10, 20, 30)
		result := calculateMomentum(bars)
		if result != nil {
			t.Errorf("calculateMomentum() = %v, want nil for < 6 bars", result)
		}
	})

	t.Run("positive momentum", func(t *testing.T) {
		// Prices rising: 90, 92, 94, 96, 98, 100
		bars := makeBars(90, 92, 94, 96, 98, 100)
		result := calculateMomentum(bars)
		if result == nil {
			t.Fatal("calculateMomentum() returned nil")
		}

		// 1-day change: 100 - 98 = 2
		if !approxEqual(result.PriceChange1D, 2.0, 0.001) {
			t.Errorf("PriceChange1D = %v, want 2.0", result.PriceChange1D)
		}
		// 5-day change: 100 - 90 = 10
		if !approxEqual(result.PriceChange5D, 10.0, 0.001) {
			t.Errorf("PriceChange5D = %v, want 10.0", result.PriceChange5D)
		}
		// 1-day % change: (100-98)/98*100 ≈ 2.04%
		if !approxEqual(result.PercentChange1D, (2.0/98.0)*100, 0.01) {
			t.Errorf("PercentChange1D = %v, want %v", result.PercentChange1D, (2.0/98.0)*100)
		}
		// 5-day % change: (100-90)/90*100 ≈ 11.11%
		if !approxEqual(result.PercentChange5D, (10.0/90.0)*100, 0.01) {
			t.Errorf("PercentChange5D = %v, want %v", result.PercentChange5D, (10.0/90.0)*100)
		}
	})

	t.Run("negative momentum", func(t *testing.T) {
		bars := makeBars(100, 98, 96, 94, 92, 90)
		result := calculateMomentum(bars)
		if result == nil {
			t.Fatal("calculateMomentum() returned nil")
		}
		if result.PriceChange1D >= 0 {
			t.Errorf("PriceChange1D = %v, want negative", result.PriceChange1D)
		}
		if result.PriceChange5D >= 0 {
			t.Errorf("PriceChange5D = %v, want negative", result.PriceChange5D)
		}
	})

	t.Run("flat momentum", func(t *testing.T) {
		bars := makeBars(100, 100, 100, 100, 100, 100)
		result := calculateMomentum(bars)
		if result == nil {
			t.Fatal("calculateMomentum() returned nil")
		}
		if result.PriceChange1D != 0 {
			t.Errorf("PriceChange1D = %v, want 0", result.PriceChange1D)
		}
		if result.PriceChange5D != 0 {
			t.Errorf("PriceChange5D = %v, want 0", result.PriceChange5D)
		}
	})
}

// --- analyzeVolume Tests ---

func TestAnalyzeVolume(t *testing.T) {
	t.Run("insufficient data returns nil", func(t *testing.T) {
		bars := makeBars(10, 20, 30)
		result := analyzeVolume(bars)
		if result != nil {
			t.Errorf("analyzeVolume() = %v, want nil for < 20 bars", result)
		}
	})

	t.Run("stable volume", func(t *testing.T) {
		data := make([]struct{ Close float64; Volume int64 }, 20)
		for i := range data {
			data[i] = struct{ Close float64; Volume int64 }{100, 1000}
		}
		bars := makeBarsWithVolume(data)
		result := analyzeVolume(bars)
		if result == nil {
			t.Fatal("analyzeVolume() returned nil")
		}
		if result.Trend != "stable" {
			t.Errorf("Trend = %q, want \"stable\"", result.Trend)
		}
		if !approxEqual(result.Ratio, 1.0, 0.01) {
			t.Errorf("Ratio = %v, want 1.0", result.Ratio)
		}
	})

	t.Run("increasing volume spike", func(t *testing.T) {
		data := make([]struct{ Close float64; Volume int64 }, 20)
		for i := range data {
			data[i] = struct{ Close float64; Volume int64 }{100, 1000}
		}
		// Last bar has 3x normal volume
		data[19].Volume = 3000
		bars := makeBarsWithVolume(data)
		result := analyzeVolume(bars)
		if result == nil {
			t.Fatal("analyzeVolume() returned nil")
		}
		// Average includes the spike: (19*1000 + 3000)/20 = 1100
		// Current = 3000, ratio = 3000/1100 ≈ 2.727
		if result.Trend != "increasing" {
			t.Errorf("Trend = %q, want \"increasing\"", result.Trend)
		}
		if result.Ratio <= 1.5 {
			t.Errorf("Ratio = %v, want > 1.5", result.Ratio)
		}
	})

	t.Run("decreasing volume", func(t *testing.T) {
		data := make([]struct{ Close float64; Volume int64 }, 20)
		for i := range data {
			data[i] = struct{ Close float64; Volume int64 }{100, 10000}
		}
		// Last bar has very low volume
		data[19].Volume = 100
		bars := makeBarsWithVolume(data)
		result := analyzeVolume(bars)
		if result == nil {
			t.Fatal("analyzeVolume() returned nil")
		}
		if result.Trend != "decreasing" {
			t.Errorf("Trend = %q, want \"decreasing\"", result.Trend)
		}
		if result.Ratio >= 0.5 {
			t.Errorf("Ratio = %v, want < 0.5", result.Ratio)
		}
	})
}

// --- generateSignal Tests ---

func TestGenerateSignal(t *testing.T) {
	tests := []struct {
		name       string
		result     *AnalysisResult
		wantSignal string
	}{
		{
			name: "strong buy: oversold RSI + bullish indicators",
			result: &AnalysisResult{
				CurrentPrice: 110,
				SMA20:        100, // price > SMA20
				SMA50:        90,  // SMA20 > SMA50 (golden cross)
				RSI:          25,  // oversold
				MACD:         &MACDResult{Histogram: 2.0},
				Momentum:     &MomentumResult{PercentChange5D: 6.0},
			},
			wantSignal: "BUY",
		},
		{
			name: "strong sell: overbought RSI + bearish indicators",
			result: &AnalysisResult{
				CurrentPrice: 80,
				SMA20:        90,  // price < SMA20
				SMA50:        100, // SMA20 < SMA50 (death cross)
				RSI:          75,  // overbought
				MACD:         &MACDResult{Histogram: -2.0},
				Momentum:     &MomentumResult{PercentChange5D: -6.0},
			},
			wantSignal: "SELL",
		},
		{
			name: "hold: mixed signals",
			result: &AnalysisResult{
				CurrentPrice: 100,
				SMA20:        100,
				SMA50:        100,
				RSI:          50,
				MACD:         &MACDResult{Histogram: 0.1},
			},
			wantSignal: "HOLD",
		},
		{
			name: "minimal data: no indicators",
			result: &AnalysisResult{
				CurrentPrice: 100,
			},
			wantSignal: "HOLD",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			signal, confidence := generateSignal(tt.result)
			if signal != tt.wantSignal {
				t.Errorf("generateSignal() signal = %q, want %q", signal, tt.wantSignal)
			}
			if confidence < 0 || confidence > 100 {
				t.Errorf("generateSignal() confidence = %v, want [0, 100]", confidence)
			}
		})
	}
}

// --- average helper Tests ---

func TestAverage(t *testing.T) {
	tests := []struct {
		name   string
		values []float64
		want   float64
	}{
		{"empty", []float64{}, 0},
		{"single", []float64{42}, 42},
		{"multiple", []float64{10, 20, 30}, 20},
		{"negatives", []float64{-10, 10}, 0},
		{"fractions", []float64{0.1, 0.2, 0.3}, 0.2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := average(tt.values)
			if !approxEqual(got, tt.want, 0.001) {
				t.Errorf("average() = %v, want %v", got, tt.want)
			}
		})
	}
}
