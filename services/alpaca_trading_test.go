package services

import (
	"testing"
)

// TestParseOCCSymbol tests the OCC symbol parser for standard option symbols.
// OCC format: {underlying}{YYMMDD}{C/P}{strike*1000 zero-padded to 8 digits}

func TestParseOCCSymbol(t *testing.T) {
	tests := []struct {
		name        string
		symbol      string
		wantStrike  float64
		wantType    string
	}{
		// Standard OCC symbols
		{
			name:       "TSLA call strike 400",
			symbol:     "TSLA251219C00400000",
			wantStrike: 400.0,
			wantType:   "call",
		},
		{
			name:       "AAPL call strike 150",
			symbol:     "AAPL231215C00150000",
			wantStrike: 150.0,
			wantType:   "call",
		},
		{
			name:       "SPY put strike 500",
			symbol:     "SPY250117P00500000",
			wantStrike: 500.0,
			wantType:   "put",
		},
		{
			name:       "MSFT put strike 42.5",
			symbol:     "MSFT260320P00042500",
			wantStrike: 42.5,
			wantType:   "put",
		},
		{
			name:       "single-char underlying",
			symbol:     "X260115C00025000",
			wantStrike: 25.0,
			wantType:   "call",
		},

		// Edge cases: invalid inputs
		{
			name:       "too short symbol",
			symbol:     "SHORT",
			wantStrike: 0,
			wantType:   "",
		},
		{
			name:       "empty string",
			symbol:     "",
			wantStrike: 0,
			wantType:   "",
		},
		{
			name:       "exactly 15 chars (too short by 1)",
			symbol:     "A251219C0040000",
			wantStrike: 0,
			wantType:   "",
		},
		{
			name:       "non-C/P at type position",
			symbol:     "TSLA251219X00400000",
			wantStrike: 0,
			wantType:   "",
		},
		{
			name:       "non-numeric strike",
			symbol:     "TSLA251219CABCDEFGH",
			wantStrike: 0,
			wantType:   "call",
		},

		// Whitespace handling (TrimSpace is applied)
		{
			name:       "whitespace around symbol",
			symbol:     "  TSLA251219C00400000  ",
			wantStrike: 400.0,
			wantType:   "call",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStrike, gotType := parseOCCSymbol(tt.symbol)
			if gotStrike != tt.wantStrike {
				t.Errorf("parseOCCSymbol(%q) strike = %v, want %v", tt.symbol, gotStrike, tt.wantStrike)
			}
			if gotType != tt.wantType {
				t.Errorf("parseOCCSymbol(%q) type = %q, want %q", tt.symbol, gotType, tt.wantType)
			}
		})
	}
}

// TestParseOCCSymbol_StrikeParsing tests the strike price extraction with various values.
func TestParseOCCSymbol_StrikeParsing(t *testing.T) {
	tests := []struct {
		name       string
		symbol     string
		wantStrike float64
	}{
		{"integer strike 100", "TSLA260115C00100000", 100.0},
		{"integer strike 999", "TSLA260115C00999000", 999.0},
		{"fractional 150.50", "TSLA260115C00150500", 150.5},
		{"small strike 5", "TSLA260115C00005000", 5.0},
		{"max 8-digit strike", "TSLA260115C99999999", 99999.999},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStrike, gotType := parseOCCSymbol(tt.symbol)
			if gotType != "call" {
				t.Fatalf("expected type 'call', got %q (test setup issue)", gotType)
			}
			if gotStrike != tt.wantStrike {
				t.Errorf("strike = %v, want %v", gotStrike, tt.wantStrike)
			}
		})
	}
}
