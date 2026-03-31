package services

import (
	"context"
	"io"
	"math"
	"prophet-trader/interfaces"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// mockTradingService implements interfaces.TradingService for testing.
type mockTradingService struct {
	placeOrderFn  func(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error)
	cancelOrderFn func(ctx context.Context, orderID string) error
	getOrderFn    func(ctx context.Context, orderID string) (*interfaces.Order, error)
}

func (m *mockTradingService) PlaceOrder(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	if m.placeOrderFn != nil {
		return m.placeOrderFn(ctx, order)
	}
	return &interfaces.OrderResult{OrderID: "mock-order-1", Status: "accepted"}, nil
}

func (m *mockTradingService) CancelOrder(ctx context.Context, orderID string) error {
	if m.cancelOrderFn != nil {
		return m.cancelOrderFn(ctx, orderID)
	}
	return nil
}

func (m *mockTradingService) GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error) {
	if m.getOrderFn != nil {
		return m.getOrderFn(ctx, orderID)
	}
	return &interfaces.Order{ID: orderID, Status: "filled"}, nil
}

func (m *mockTradingService) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return nil, nil
}

func (m *mockTradingService) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	return nil, nil
}

func (m *mockTradingService) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return &interfaces.Account{Cash: 100000, BuyingPower: 200000}, nil
}

func (m *mockTradingService) PlaceOptionsOrder(_ context.Context, _ *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	return nil, nil
}

func (m *mockTradingService) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return nil, nil
}

func (m *mockTradingService) GetOptionsQuote(_ context.Context, _ string) (*interfaces.OptionsQuote, error) {
	return nil, nil
}

func (m *mockTradingService) GetOptionsPosition(_ context.Context, _ string) (*interfaces.OptionsPosition, error) {
	return nil, nil
}

func (m *mockTradingService) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return nil, nil
}

// mockDataService implements interfaces.DataService for testing.
type mockDataService struct {
	latestQuote *interfaces.Quote
}

func (m *mockDataService) GetHistoricalBars(_ context.Context, _ string, _, _ time.Time, _ string) ([]*interfaces.Bar, error) {
	return nil, nil
}

func (m *mockDataService) GetLatestBar(_ context.Context, _ string) (*interfaces.Bar, error) {
	return nil, nil
}

func (m *mockDataService) GetLatestQuote(_ context.Context, _ string) (*interfaces.Quote, error) {
	if m.latestQuote != nil {
		return m.latestQuote, nil
	}
	return &interfaces.Quote{AskPrice: 150.0, BidPrice: 149.90}, nil
}

func (m *mockDataService) GetLatestTrade(_ context.Context, _ string) (*interfaces.Trade, error) {
	return nil, nil
}

func (m *mockDataService) StreamBars(_ context.Context, _ []string) (<-chan *interfaces.Bar, error) {
	return nil, nil
}

// newTestLogger creates a logger for tests (avoids nil pointer panics).
func newTestLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(io.Discard)
	return l
}

func TestValidateRequest(t *testing.T) {
	// Create a minimal PositionManager for testing unexported methods.
	pm := &PositionManager{logger: newTestLogger()}

	stopPct := 5.0
	profitPct := 10.0
	limitPrice := 150.0

	tests := []struct {
		name    string
		req     *PlaceManagedPositionRequest
		wantErr bool
	}{
		{
			name: "valid buy with percent stops",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "buy",
				AllocationDollars: 10000,
				StopLossPercent:   &stopPct,
				TakeProfitPercent: &profitPct,
			},
			wantErr: false,
		},
		{
			name: "valid sell with percent stops",
			req: &PlaceManagedPositionRequest{
				Symbol:            "TSLA",
				Side:              "sell",
				AllocationDollars: 5000,
				StopLossPercent:   &stopPct,
				TakeProfitPercent: &profitPct,
			},
			wantErr: false,
		},
		{
			name: "invalid side",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "hold",
				AllocationDollars: 10000,
				StopLossPercent:   &stopPct,
				TakeProfitPercent: &profitPct,
			},
			wantErr: true,
		},
		{
			name: "missing stop loss",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "buy",
				AllocationDollars: 10000,
				TakeProfitPercent: &profitPct,
			},
			wantErr: true,
		},
		{
			name: "missing take profit",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "buy",
				AllocationDollars: 10000,
				StopLossPercent:   &stopPct,
			},
			wantErr: true,
		},
		{
			name: "limit order without entry price",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "buy",
				AllocationDollars: 10000,
				EntryStrategy:     "limit",
				StopLossPercent:   &stopPct,
				TakeProfitPercent: &profitPct,
			},
			wantErr: true,
		},
		{
			name: "limit order with entry price",
			req: &PlaceManagedPositionRequest{
				Symbol:            "AAPL",
				Side:              "buy",
				AllocationDollars: 10000,
				EntryStrategy:     "limit",
				EntryPrice:        &limitPrice,
				StopLossPercent:   &stopPct,
				TakeProfitPercent: &profitPct,
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := pm.validateRequest(tt.req)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateRequest() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// --- calculateQuantity Tests ---

func TestCalculateQuantity(t *testing.T) {
	pm := &PositionManager{logger: newTestLogger()}

	tests := []struct {
		name       string
		allocation float64
		price      float64
		want       float64
	}{
		{"whole shares", 10000, 100, 100},
		{"fractional truncated", 10000, 33, 303},       // 10000/33 = 303.03 → 303
		{"less than 1 share", 50, 100, 0},               // 50/100 = 0.5 → 0
		{"expensive stock", 5000, 3000, 1},               // 5000/3000 = 1.66 → 1
		{"penny stock", 1000, 0.50, 2000},                // 1000/0.50 = 2000
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pm.calculateQuantity(tt.allocation, tt.price)
			if got != tt.want {
				t.Errorf("calculateQuantity(%v, %v) = %v, want %v", tt.allocation, tt.price, got, tt.want)
			}
		})
	}
}

// --- calculateStopLoss Tests ---

func TestCalculateStopLoss(t *testing.T) {
	pm := &PositionManager{logger: newTestLogger()}

	tests := []struct {
		name       string
		entry      float64
		stopPrice  *float64
		stopPct    *float64
		side       string
		want       float64
	}{
		{
			name:  "buy with 5% stop",
			entry: 100,
			stopPct: func() *float64 { v := 5.0; return &v }(),
			side:  "buy",
			want:  95.0, // 100 * (1 - 5/100)
		},
		{
			name:  "sell with 5% stop",
			entry: 100,
			stopPct: func() *float64 { v := 5.0; return &v }(),
			side:  "sell",
			want:  105.0, // 100 * (1 + 5/100)
		},
		{
			name:      "explicit stop price overrides percent",
			entry:     100,
			stopPrice: func() *float64 { v := 92.0; return &v }(),
			stopPct:   func() *float64 { v := 5.0; return &v }(),
			side:      "buy",
			want:      92.0,
		},
		{
			name:  "buy with 10% stop",
			entry: 200,
			stopPct: func() *float64 { v := 10.0; return &v }(),
			side:  "buy",
			want:  180.0, // 200 * (1 - 10/100)
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pm.calculateStopLoss(tt.entry, tt.stopPrice, tt.stopPct, tt.side)
			if !approxEqual(got, tt.want, 0.01) {
				t.Errorf("calculateStopLoss() = %v, want %v", got, tt.want)
			}
		})
	}
}

// --- calculateTakeProfit Tests ---

func TestCalculateTakeProfit(t *testing.T) {
	pm := &PositionManager{logger: newTestLogger()}

	tests := []struct {
		name        string
		entry       float64
		profitPrice *float64
		profitPct   *float64
		side        string
		want        float64
	}{
		{
			name:  "buy with 10% profit",
			entry: 100,
			profitPct: func() *float64 { v := 10.0; return &v }(),
			side:  "buy",
			want:  110.0,
		},
		{
			name:  "sell with 10% profit",
			entry: 100,
			profitPct: func() *float64 { v := 10.0; return &v }(),
			side:  "sell",
			want:  90.0,
		},
		{
			name:        "explicit profit price",
			entry:       100,
			profitPrice: func() *float64 { v := 125.0; return &v }(),
			profitPct:   func() *float64 { v := 10.0; return &v }(),
			side:        "buy",
			want:        125.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pm.calculateTakeProfit(tt.entry, tt.profitPrice, tt.profitPct, tt.side)
			if !approxEqual(got, tt.want, 0.01) {
				t.Errorf("calculateTakeProfit() = %v, want %v", got, tt.want)
			}
		})
	}
}

// --- calculatePartialExitPrice Tests ---

func TestCalculatePartialExitPrice(t *testing.T) {
	pm := &PositionManager{logger: newTestLogger()}

	tests := []struct {
		name      string
		entry     float64
		targetPct float64
		side      string
		want      float64
	}{
		{"buy 5% partial", 100, 5, "buy", 105.0},
		{"sell 5% partial", 100, 5, "sell", 95.0},
		{"buy 20% partial", 200, 20, "buy", 240.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pm.calculatePartialExitPrice(tt.entry, tt.targetPct, tt.side)
			if !approxEqual(got, tt.want, 0.01) {
				t.Errorf("calculatePartialExitPrice() = %v, want %v", got, tt.want)
			}
		})
	}
}

// --- updatePositionPrice Tests ---

func TestUpdatePositionPrice(t *testing.T) {
	tests := []struct {
		name       string
		position   *ManagedPosition
		askPrice   float64
		wantPL     float64
		wantPLPC   float64
	}{
		{
			name: "long position with profit",
			position: &ManagedPosition{
				Symbol:       "AAPL",
				Side:         "buy",
				EntryPrice:   100,
				RemainingQty: 10,
			},
			askPrice: 110,
			wantPL:   100.0,  // (110-100)*10
			wantPLPC: 10.0,   // (110-100)/100*100
		},
		{
			name: "long position with loss",
			position: &ManagedPosition{
				Symbol:       "AAPL",
				Side:         "buy",
				EntryPrice:   100,
				RemainingQty: 10,
			},
			askPrice: 90,
			wantPL:   -100.0, // (90-100)*10
			wantPLPC: -10.0,
		},
		{
			name: "short position with profit",
			position: &ManagedPosition{
				Symbol:       "TSLA",
				Side:         "sell",
				EntryPrice:   100,
				RemainingQty: 5,
			},
			askPrice: 90,
			wantPL:   50.0,  // (100-90)*5
			wantPLPC: 10.0,  // (100-90)/100*100
		},
		{
			name: "short position with loss",
			position: &ManagedPosition{
				Symbol:       "TSLA",
				Side:         "sell",
				EntryPrice:   100,
				RemainingQty: 5,
			},
			askPrice: 110,
			wantPL:   -50.0,
			wantPLPC: -10.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pm := &PositionManager{
				logger: newTestLogger(),
				dataService: &mockDataService{
					latestQuote: &interfaces.Quote{AskPrice: tt.askPrice, BidPrice: tt.askPrice - 0.1},
				},
			}

			err := pm.updatePositionPrice(context.Background(), tt.position)
			if err != nil {
				t.Fatalf("updatePositionPrice() error = %v", err)
			}
			if !approxEqual(tt.position.CurrentPrice, tt.askPrice, 0.01) {
				t.Errorf("CurrentPrice = %v, want %v", tt.position.CurrentPrice, tt.askPrice)
			}
			if !approxEqual(tt.position.UnrealizedPL, tt.wantPL, 0.01) {
				t.Errorf("UnrealizedPL = %v, want %v", tt.position.UnrealizedPL, tt.wantPL)
			}
			if !approxEqual(tt.position.UnrealizedPLPC, tt.wantPLPC, 0.01) {
				t.Errorf("UnrealizedPLPC = %v, want %v", tt.position.UnrealizedPLPC, tt.wantPLPC)
			}
		})
	}
}

// --- updateTrailingStop Tests ---

func TestUpdateTrailingStop(t *testing.T) {
	t.Run("long: raises stop when price rises", func(t *testing.T) {
		var cancelledOrderID string
		trading := &mockTradingService{
			cancelOrderFn: func(_ context.Context, orderID string) error {
				cancelledOrderID = orderID
				return nil
			},
			placeOrderFn: func(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
				return &interfaces.OrderResult{OrderID: "new-stop-order", Status: "accepted"}, nil
			},
		}

		pm := &PositionManager{
			tradingService: trading,
			dataService:    &mockDataService{},
			logger:         newTestLogger(),
		}

		position := &ManagedPosition{
			ID:              "pos-1",
			Symbol:          "AAPL",
			Side:            "buy",
			TrailingStop:    true,
			TrailingPercent: 5.0,
			CurrentPrice:    120, // Price rose
			StopLossPrice:   95,  // Old stop
			StopLossOrderID: "old-stop-order",
			RemainingQty:    10,
		}

		pm.updateTrailingStop(context.Background(), position)

		// New stop should be 120 * (1 - 5/100) = 114
		expectedStop := 120 * (1 - 5.0/100.0)
		if !approxEqual(position.StopLossPrice, expectedStop, 0.01) {
			t.Errorf("StopLossPrice = %v, want %v", position.StopLossPrice, expectedStop)
		}
		if cancelledOrderID != "old-stop-order" {
			t.Errorf("cancelled order = %q, want %q", cancelledOrderID, "old-stop-order")
		}
	})

	t.Run("long: does not lower stop", func(t *testing.T) {
		pm := &PositionManager{
			tradingService: &mockTradingService{},
			dataService:    &mockDataService{},
			logger:         newTestLogger(),
		}

		position := &ManagedPosition{
			ID:              "pos-1",
			Symbol:          "AAPL",
			Side:            "buy",
			TrailingStop:    true,
			TrailingPercent: 5.0,
			CurrentPrice:    90,  // Price fell
			StopLossPrice:   100, // Existing stop is higher than new would-be stop
			StopLossOrderID: "existing-stop",
			RemainingQty:    10,
		}

		pm.updateTrailingStop(context.Background(), position)

		// Stop should remain unchanged
		if position.StopLossPrice != 100 {
			t.Errorf("StopLossPrice changed to %v, should remain 100", position.StopLossPrice)
		}
	})

	t.Run("short: lowers stop when price falls", func(t *testing.T) {
		trading := &mockTradingService{
			placeOrderFn: func(_ context.Context, _ *interfaces.Order) (*interfaces.OrderResult, error) {
				return &interfaces.OrderResult{OrderID: "new-stop", Status: "accepted"}, nil
			},
		}

		pm := &PositionManager{
			tradingService: trading,
			dataService:    &mockDataService{},
			logger:         newTestLogger(),
		}

		position := &ManagedPosition{
			ID:              "pos-2",
			Symbol:          "TSLA",
			Side:            "sell",
			TrailingStop:    true,
			TrailingPercent: 5.0,
			CurrentPrice:    80,   // Price fell (good for short)
			StopLossPrice:   110,  // Old stop was higher
			StopLossOrderID: "old-stop",
			RemainingQty:    5,
		}

		pm.updateTrailingStop(context.Background(), position)

		// New stop: 80 * (1 + 5/100) = 84
		expectedStop := 80 * (1 + 5.0/100.0)
		if !approxEqual(position.StopLossPrice, expectedStop, 0.01) {
			t.Errorf("StopLossPrice = %v, want %v", position.StopLossPrice, expectedStop)
		}
	})

	t.Run("short: does not raise stop", func(t *testing.T) {
		pm := &PositionManager{
			tradingService: &mockTradingService{},
			dataService:    &mockDataService{},
			logger:         newTestLogger(),
		}

		position := &ManagedPosition{
			ID:              "pos-2",
			Symbol:          "TSLA",
			Side:            "sell",
			TrailingStop:    true,
			TrailingPercent: 5.0,
			CurrentPrice:    100,  // Price rose (bad for short)
			StopLossPrice:   84,   // Existing stop is lower than new would-be
			StopLossOrderID: "existing-stop",
			RemainingQty:    5,
		}

		pm.updateTrailingStop(context.Background(), position)

		// 100 * 1.05 = 105 > 84, so stop should NOT change
		if position.StopLossPrice != 84 {
			t.Errorf("StopLossPrice changed to %v, should remain 84", position.StopLossPrice)
		}
	})
}

// --- ListManagedPositions Tests ---

func TestListManagedPositions(t *testing.T) {
	pm := &PositionManager{
		logger: newTestLogger(),
		positions: map[string]*ManagedPosition{
			"active-1": {
				ID: "active-1", Symbol: "AAPL", Status: "ACTIVE",
				CreatedAt: time.Now(),
			},
			"active-2": {
				ID: "active-2", Symbol: "TSLA", Status: "ACTIVE",
				CreatedAt: time.Now(),
			},
			"closed-1": {
				ID: "closed-1", Symbol: "MSFT", Status: "CLOSED",
				CreatedAt: time.Now(),
			},
			"stale-pending": {
				ID: "stale-pending", Symbol: "GOOG", Status: "PENDING",
				CreatedAt: time.Now().Add(-48 * time.Hour), // 2 days old
			},
			"fresh-pending": {
				ID: "fresh-pending", Symbol: "AMZN", Status: "PENDING",
				CreatedAt: time.Now().Add(-1 * time.Hour), // 1 hour old
			},
		},
	}

	t.Run("all statuses", func(t *testing.T) {
		all := pm.ListManagedPositions("")
		// Should include active-1, active-2, closed-1, fresh-pending but NOT stale-pending
		if len(all) != 4 {
			t.Errorf("ListManagedPositions(\"\") returned %d, want 4", len(all))
		}
		for _, pos := range all {
			if pos.ID == "stale-pending" {
				t.Error("stale PENDING position should be filtered out")
			}
		}
	})

	t.Run("filter by ACTIVE", func(t *testing.T) {
		active := pm.ListManagedPositions("ACTIVE")
		if len(active) != 2 {
			t.Errorf("ListManagedPositions(\"ACTIVE\") returned %d, want 2", len(active))
		}
	})

	t.Run("filter by CLOSED", func(t *testing.T) {
		closed := pm.ListManagedPositions("CLOSED")
		if len(closed) != 1 {
			t.Errorf("ListManagedPositions(\"CLOSED\") returned %d, want 1", len(closed))
		}
	})
}

// --- GetManagedPosition Tests ---

func TestGetManagedPosition(t *testing.T) {
	pm := &PositionManager{
		logger: newTestLogger(),
		positions: map[string]*ManagedPosition{
			"pos-1": {ID: "pos-1", Symbol: "AAPL"},
		},
	}

	t.Run("found", func(t *testing.T) {
		pos, err := pm.GetManagedPosition("pos-1")
		if err != nil {
			t.Fatalf("GetManagedPosition() error = %v", err)
		}
		if pos.Symbol != "AAPL" {
			t.Errorf("Symbol = %q, want %q", pos.Symbol, "AAPL")
		}
	})

	t.Run("not found", func(t *testing.T) {
		_, err := pm.GetManagedPosition("nonexistent")
		if err == nil {
			t.Error("GetManagedPosition() expected error for missing position")
		}
	})
}

// reuse approxEqual from technical_analysis_test.go — redeclared here since tests
// are in separate files but same package; Go allows only one definition.
// We use math.Abs directly instead.
func pmApproxEqual(a, b, epsilon float64) bool {
	return math.Abs(a-b) < epsilon
}
