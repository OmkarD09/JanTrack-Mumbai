import { Layout } from "@/components/layout";
import { CandidateCard } from "@/components/candidate-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ArrowLeftRight, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";

// Define Candidate Type (matching the one in admin.tsx/API)
import { Candidate } from "@shared/schema";

export default function CandidatesPage() {
  const [location] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const initialSearch = searchParams.get("q") || "";

  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [wardFilter, setWardFilter] = useState("all");
  const [partyFilter, setPartyFilter] = useState("all");

  const ITEMS_PER_PAGE = 18;

  // 1. Fetch first page of candidates instantly
  const { data: initialCandidates = [], isLoading: isInitialLoading, error: initialError } = useQuery<Candidate[]>({
    queryKey: [`/api/candidates?limit=${ITEMS_PER_PAGE}`],
  });

  // 2. Fetch all candidates in the background for filtering/pagination
  const { data: allCandidates = [], isLoading: isAllLoading, error: allError } = useQuery<Candidate[]>({
    queryKey: ["/api/candidates"],
  });

  const candidates = allCandidates.length > 0 ? allCandidates : initialCandidates;
  const isLoading = isInitialLoading && allCandidates.length === 0;
  const error = initialError || (allCandidates.length === 0 ? allError : null);

  const sortedCandidates = [...candidates].sort((a, b) => {
    return (parseInt(a.id) || 0) - (parseInt(b.id) || 0);
  });

  const filteredCandidates = sortedCandidates.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.constituency.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesWard = wardFilter === "all" || c.ward === wardFilter;
    const matchesParty = partyFilter === "all" || c.party === partyFilter;
    return matchesSearch && matchesWard && matchesParty;
  });

  const uniqueParties = Array.from(new Set(candidates.map(c => c.party))).filter(p => p && p.trim() !== "").sort();

  const uniqueWards = Array.from(new Set(candidates.map(c => c.ward))).filter(w => w && w.trim() !== "").sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, '')) || 0;
    const numB = parseInt(b.replace(/\D/g, '')) || 0;
    return numA - numB;
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="flex justify-center items-center h-[50vh]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="flex justify-center items-center h-[50vh] text-destructive">
          Failed to load candidates.
        </div>
      </Layout>
    );
  }

  /* Pagination Logic */
  const [currentPage, setCurrentPage] = useState(1);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, wardFilter, partyFilter]);

  const totalPages = Math.ceil(filteredCandidates.length / ITEMS_PER_PAGE);
  const paginatedCandidates = filteredCandidates.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );


  /* Smart Pagination Logic */
  const getPageNumbers = () => {
    const pages = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push("...");

      let start = Math.max(2, currentPage - 1);
      let end = Math.min(totalPages - 1, currentPage + 1);

      if (currentPage <= 3) { start = 2; end = 4; }
      if (currentPage >= totalPages - 2) { start = totalPages - 3; end = totalPages - 1; }

      for (let i = start; i <= end; i++) pages.push(i);

      if (currentPage < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <Layout>
      <div className="bg-primary/5 border-b">
        <div className="container mx-auto px-4 py-12">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
            <div>
              <h1 className="text-4xl font-serif font-bold text-primary mb-4">Mumbai Candidates 2026</h1>
              <p className="text-lg text-muted-foreground">
                Browse and filter through all verified candidates across Mumbai's BMC wards.
              </p>
            </div>
            {wardFilter !== "all" && (
              <Link href={`/compare?ward=${wardFilter}`}>
                <Button className="gap-2 bg-secondary text-primary hover:bg-secondary/90 shadow-lg shadow-secondary/20">
                  <ArrowLeftRight size={18} /> Compare Ward Candidates
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row gap-4 mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or constituency..."
              className="pl-10"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
            <Select value={partyFilter} onValueChange={setPartyFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by Party" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Parties</SelectItem>
                {uniqueParties.map(party => (
                  <SelectItem key={party} value={party}>{party}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={wardFilter} onValueChange={setWardFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by Ward" />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                <SelectItem value="all">All Wards</SelectItem>
                {uniqueWards.map(ward => (
                  <SelectItem key={ward} value={ward}>{ward}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {paginatedCandidates.map(candidate => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex justify-center items-center gap-2 mt-8 py-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
            >
              Previous
            </Button>

            <div className="flex gap-1 mx-2 flex-wrap justify-center items-center">
              {getPageNumbers().map((page, i) => (
                typeof page === 'number' ? (
                  <Button
                    key={page}
                    variant={currentPage === page ? "default" : "outline"}
                    size="sm"
                    className="w-8 h-8 p-0"
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </Button>
                ) : (
                  <span key={`ellipsis-${i}`} className="px-2 text-muted-foreground">...</span>
                )
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
            >
              Next
            </Button>
          </div>
        )}

        {filteredCandidates.length === 0 && (
          <div className="text-center py-20 text-muted-foreground">
            No candidates found matching your criteria.
          </div>
        )}
      </div>
    </Layout>
  );
}
