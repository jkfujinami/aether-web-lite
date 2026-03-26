use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap},
    Frame,
};
use crate::tui::app::App;

pub fn render(app: &mut App, f: &mut Frame) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // Header
            Constraint::Min(10),    // Main content
            Constraint::Length(10), // Logs
        ])
        .split(f.size());

    // --- Header ---
    let header = Paragraph::new(format!(
        " [AETHER Stable Node] ID: {} | Ring Position: {:.4} | Status: Healthy",
        app.peer_id, app.position
    ))
    .block(Block::default().borders(Borders::ALL).title(" Node Info "))
    .style(Style::default().fg(Color::Cyan));
    f.render_widget(header, chunks[0]);

    // --- Main: Peers & Storage ---
    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(70), // Peer table
            Constraint::Percentage(30), // Storage stats
        ])
        .split(chunks[1]);

    // Peer Table
    let rows: Vec<Row> = app
        .connected_peers
        .iter()
        .map(|p| {
            Row::new(vec![
                Cell::from(p.peer_id.clone()),
                Cell::from(format!("{:.4}", p.position)),
                Cell::from("Connected"),
            ])
        })
        .collect();

    let peer_table = Table::new(
        rows,
        [
            Constraint::Percentage(50),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ],
    )
    .header(
        Row::new(vec!["Peer ID", "Position", "Status"])
            .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
    )
    .block(Block::default().borders(Borders::ALL).title(" Connected Peers "))
    .highlight_style(Style::default().add_modifier(Modifier::REVERSED));
    f.render_widget(peer_table, main_chunks[0]);

    // Storage Widget
    let storage_content = vec![
        Line::from(vec![
            Span::styled("Topic Count: ", Style::default().fg(Color::Yellow)),
            Span::raw(format!("{}", app.storage_stats.topic_count)),
        ]),
        Line::from(vec![
            Span::styled("DB Size: ", Style::default().fg(Color::Yellow)),
            Span::raw(format!("{:.2} KB", app.storage_stats.total_size_kb)),
        ]),
    ];
    let storage_widget = Paragraph::new(storage_content)
        .block(Block::default().borders(Borders::ALL).title(" Storage Statistics "))
        .wrap(Wrap { trim: true });
    f.render_widget(storage_widget, main_chunks[1]);

    // --- Logs ---
    let log_lines: Vec<Line> = app
        .logs
        .iter()
        .map(|l| Line::from(Span::styled(l, Style::default().fg(Color::Gray))))
        .collect();
    let logs_widget = Paragraph::new(log_lines)
        .block(Block::default().borders(Borders::ALL).title(" Activity Log "))
        .wrap(Wrap { trim: true });
    f.render_widget(logs_widget, chunks[2]);
}
